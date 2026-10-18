import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import {
  type BoundTool,
  bindTools,
  type CrewmateTool,
  type CrewmateToolDelegate,
  toolContent,
} from "../session/tools";
import { CLAUDE_SEAT_TOOL_SERVER } from "../storage/sessionReader";

/**
 * The tool spec (primitives P7) over Claude's in-process tool server. Every
 * tool a Claude model gets - a crewmate's or the Firstmate's - is generated
 * here from the same bound tool the Pi side generates its tool from - the
 * name, the description, the parameters and the run - so a card, a
 * follow-up or a report reads and behaves the same whichever subscription
 * produced it, and a new tool reaches this runtime without a line here.
 */

/**
 * A call of one of the Claude client's own coding tools a coding crewmate
 * holds beside ours, typed by the arguments the SDK declares for it.
 */
export type ClaudeCodingBuiltinCall =
  | { name: "Bash"; args: BashInput }
  | { name: "Read"; args: FileReadInput }
  | { name: "Edit"; args: FileEditInput }
  | { name: "Write"; args: FileWriteInput };

/** The JSON Schema subset the crewmate tools use, as typebox writes it. */
type JsonSchema = {
  type?: string;
  description?: string;
  const?: string | number | boolean;
  enum?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
};

/**
 * One parameter schema as zod, for the client's tool server. Anything
 * outside the subset throws rather than serving a looser schema than Pi
 * does, so a new kind of parameter fails its first test here.
 */
function zodOf(schema: JsonSchema, at: string): z.ZodType {
  // One of a fixed set of words (`stringEnum`).
  if (schema.enum) {
    if (schema.type !== "string" || schema.enum.length === 0) {
      throw new Error(`${at}: an enum Claude's tool server cannot carry`);
    }
    return z.enum(schema.enum as [string, ...string[]]);
  }
  const members = schema.anyOf ?? schema.oneOf;
  if (members) {
    if (members.length === 2 && members.some((member) => member.type === "null")) {
      const value = members.find((member) => member.type !== "null");
      if (value) return zodOf(value, at).nullable();
    }
    if (members.every((member) => member.type === "object" && member.properties?.kind?.const)) {
      return z.discriminatedUnion(
        "kind",
        members.map((member) => zodObjectOf(member, at)) as unknown as [
          z.ZodObject,
          ...z.ZodObject[],
        ],
      );
    }
    throw new Error(`${at}: a union Claude's tool server cannot carry`);
  }
  if (schema.const !== undefined) return z.literal(schema.const);
  switch (schema.type) {
    case "string": {
      let string = z.string();
      if (schema.minLength !== undefined) string = string.min(schema.minLength);
      if (schema.maxLength !== undefined) string = string.max(schema.maxLength);
      if (schema.pattern !== undefined) string = string.regex(new RegExp(schema.pattern));
      return string;
    }
    case "boolean":
      return z.boolean();
    case "number":
    case "integer": {
      let number = schema.type === "integer" ? z.number().int() : z.number();
      if (schema.minimum !== undefined) number = number.min(schema.minimum);
      if (schema.maximum !== undefined) number = number.max(schema.maximum);
      return number;
    }
    case "array": {
      if (!schema.items) throw new Error(`${at}: an array without items`);
      let array = z.array(zodOf(schema.items, `${at}[]`));
      if (schema.minItems !== undefined) array = array.min(schema.minItems);
      if (schema.maxItems !== undefined) array = array.max(schema.maxItems);
      return array;
    }
    case "object":
      return zodObjectOf(schema, at);
    default:
      throw new Error(`${at}: a parameter type Claude's tool server cannot carry`);
  }
}

/** An object's fields, each optional unless required, each with its own description. */
export function zodShapeOf(schema: JsonSchema, at = "parameters"): Record<string, z.ZodType> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) => {
      const base = zodOf(property, `${at}.${name}`);
      const optional = required.has(name) ? base : base.optional();
      return [
        name,
        property.description !== undefined ? optional.describe(property.description) : optional,
      ];
    }),
  );
}

function zodObjectOf(schema: JsonSchema, at: string): z.ZodObject {
  // A map (a record's pattern properties) has no fields to declare.
  if (!schema.properties) throw new Error(`${at}: an object without declared fields`);
  const object = z.object(zodShapeOf(schema, at));
  return schema.additionalProperties === true ? object.passthrough() : object;
}

/** The Claude tool for one bound tool. */
export function claudeToolOf(bound: BoundTool) {
  return tool(
    bound.name,
    bound.description,
    zodShapeOf(bound.parameters as JsonSchema),
    async (params, extra) => {
      const signal =
        extra !== null &&
        typeof extra === "object" &&
        "signal" in extra &&
        extra.signal instanceof AbortSignal
          ? extra.signal
          : undefined;
      if (!signal) return { content: toolContent(await bound.run(params)) };
      // Only Claude's typed MCP timeout is the give-up backstop. Ordinary
      // turn cancellation must still let a request receive its real answer.
      const giveUp = new AbortController();
      const abort = () => {
        const reason = signal.reason;
        // MCP cancellation notifications serialize their error as String(error).
        // Read only its protocol-code prefix, never the human timeout message.
        const timedOut =
          typeof reason === "string"
            ? reason.startsWith(String(new McpError(ErrorCode.RequestTimeout, "")))
            : reason !== null &&
              typeof reason === "object" &&
              "code" in reason &&
              reason.code === ErrorCode.RequestTimeout;
        if (timedOut) giveUp.abort(reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      try {
        return { content: toolContent(await bound.run(params, giveUp.signal)) };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  );
}

/** Bound tools as Claude tools, in order: the Firstmate seat's whole set. */
export function claudeToolsOf(tools: readonly BoundTool[]) {
  return tools.map(claudeToolOf);
}

/**
 * The app's in-process tool server for a session's bound tools, under the
 * app's one server name. Registered always-load (contract v2.0, captain
 * ruling D2): the client defers MCP tools behind ToolSearch by default,
 * which left the card contract out of context until the model asked for it
 * (22 ToolSearch calls for emit_card across the Sep 15 transcripts); these
 * tools are the session's outputs, so they are present on turn 1.
 *
 * The transport guard (`claudeToolSurface.test.ts`) captures what this exact
 * server serves, rather than a lookalike built beside it: the client
 * truncates a tool description at 2,048 characters and drops every nested
 * parameter description, and nothing noticed for weeks.
 */
export function claudeToolServer(tools: readonly BoundTool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: CLAUDE_SEAT_TOOL_SERVER,
    alwaysLoad: true,
    tools: claudeToolsOf(tools),
  });
}

/** A Claude crewmate's app-owned tools: every entry its callbacks bind, in the spec's order. */
export function claudeCrewmateTools(
  delegate: CrewmateToolDelegate,
  tools: readonly CrewmateTool[] = CREWMATE_TOOLS,
) {
  return claudeToolsOf(bindTools(tools, delegate));
}
