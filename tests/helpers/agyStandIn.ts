/**
 * A scripted stand-in for the Antigravity program's mode for other apps
 * (`agy acp`), for the Antigravity backend's tests (INF-3776's approved plan:
 * "test against a scripted stand-in", never a real Google sign-in). It
 * speaks the Agent Client Protocol on its stdin and stdout, one JSON-RPC
 * message per line, the way the program does, and plays one scenario: what
 * it says it is, whether it is signed in, the models it offers, and what
 * each prompt does - words, thinking, a call of one of the app's tools over
 * the MCP server the client named, a shell command of its own, a permission
 * question, moving to another model on its own, waiting for a cancel, or
 * exiting mid-turn.
 *
 * Everything it receives goes to a log, one JSON line each, so a test reads
 * what the client sent; the tool server's key is logged only as present.
 * The log outlives the process, so a scenario's turns count across restarts.
 *
 *   node tests/helpers/agyStandIn.ts <scenario.json> <log.jsonl>
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type AgyStep =
  | { say: string }
  | { think: string }
  | { tool: { name: string; args: unknown } }
  | { shell: { command: string; output: string } }
  | { permission: true }
  | { wait: "cancel" }
  | { exit: number }
  | { stop: string }
  | { usage: Record<string, number> }
  /** The program moves the conversation to another model on its own. */
  | { moveModel: string };

export type AgyScenario = {
  version?: string;
  /**
   * MCP over HTTP: advertised (the default); `unadvertised`, as the installed
   * 1.5.6 does, which names no MCP capability yet lists the tool server's
   * tools when a conversation opens; or false, neither.
   */
  mcpHttp?: boolean | "unadvertised";
  /** Whether it reopens a conversation with `session/resume`. */
  resume?: boolean;
  /** `required` answers `session/new` with the protocol's sign-in error. */
  auth?: "required";
  models?: { id: string; name: string }[];
  currentModel?: string;
  thoughtLevels?: string[];
  /** How many model changes it refuses, counted across every process the log holds. */
  refuseModelSets?: number;
  /** Each prompt's steps, in order across every process the log holds. */
  turns: AgyStep[][];
};

type Message = { id?: number | string; method?: string; params?: Record<string, unknown> };
type Http = { type: string; name: string; url: string; headers: { name: string; value: string }[] };

const [scenarioPath, logPath] = process.argv.slice(2);
if (!scenarioPath || !logPath) throw new Error("usage: agyStandIn.ts <scenario.json> <log.jsonl>");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as AgyScenario;
const models = scenario.models ?? [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }];
let currentModel = scenario.currentModel ?? models[0]?.id ?? "";

function log(entry: Record<string, unknown>): void {
  appendFileSync(logPath as string, `${JSON.stringify(entry)}\n`);
}

function logged(): Record<string, unknown>[] {
  if (!existsSync(logPath as string)) return [];
  return readFileSync(logPath as string, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

let nextId = 1;
const waiting = new Map<number, (result: unknown) => void>();
function ask(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: body } });
}

/** The session's offered choices, as `session/new` answers them. */
function configOptions(): unknown[] {
  const options: unknown[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: models.map((model) => ({ value: model.id, name: model.name })),
    },
  ];
  if (scenario.thoughtLevels) {
    options.push({
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: scenario.thoughtLevels[0],
      options: scenario.thoughtLevels.map((level) => ({ value: level, name: level })),
    });
  }
  return options;
}

const servers = new Map<string, Http[]>();
let cancelled: (() => void) | undefined;
let promptCount = logged().filter((entry) => entry.method === "session/prompt").length;

function redacted(params: Record<string, unknown> | undefined): unknown {
  if (!params || !Array.isArray(params.mcpServers)) return params;
  return {
    ...params,
    mcpServers: (params.mcpServers as Http[]).map((server) => ({
      ...server,
      headers: server.headers.map((header) => ({ name: header.name, value: "(present)" })),
    })),
  };
}

async function toolClient(sessionId: string): Promise<Client> {
  const server = servers.get(sessionId)?.find((candidate) => candidate.type === "http");
  if (!server) throw new Error("no http tool server was named");
  const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
  const client = new Client({ name: "agy-stand-in", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
  );
  return client;
}

/** The installed program's habit: list the tool server's tools before a conversation's answer. */
async function listWhenOpened(sessionId: string): Promise<void> {
  if (scenario.mcpHttp !== "unadvertised") return;
  const client = await toolClient(sessionId);
  try {
    const listed = await client.listTools();
    log({ listedWhenOpened: listed.tools.map((tool) => tool.name) });
  } finally {
    await client.close();
  }
}

async function callTool(sessionId: string, name: string, args: unknown): Promise<unknown> {
  const client = await toolClient(sessionId);
  try {
    const listed = await client.listTools();
    log({ listedTools: listed.tools.map((tool) => tool.name) });
    return await client.callTool({ name, arguments: args as Record<string, unknown> });
  } finally {
    await client.close();
  }
}

async function runTurn(id: number | string, sessionId: string, steps: AgyStep[]): Promise<void> {
  let stopReason = "end_turn";
  let usage: Record<string, number> | undefined;
  let call = 0;
  for (const step of steps) {
    if ("say" in step) {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: step.say },
      });
    } else if ("think" in step) {
      update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: step.think },
      });
    } else if ("tool" in step) {
      const toolCallId = `call-${promptCount}-${call++}`;
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `mcp_infinitary_${step.tool.name}`,
        kind: "other",
        status: "pending",
        rawInput: step.tool.args,
      });
      const result = (await callTool(sessionId, step.tool.name, step.tool.args)) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      log({ toolResult: result });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: result.isError ? "failed" : "completed",
        content: (result.content ?? []).map((item) => ({ type: "content", content: item })),
      });
    } else if ("shell" in step) {
      const toolCallId = `call-${promptCount}-${call++}`;
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `Run ${step.shell.command}`,
        kind: "execute",
        status: "in_progress",
        rawInput: { command: step.shell.command },
      });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: step.shell.output,
      });
    } else if ("permission" in step) {
      const answer = await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: `call-${promptCount}-${call}`, title: "Write a file" },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      log({ permission: answer });
    } else if ("wait" in step) {
      await new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      stopReason = "cancelled";
      break;
    } else if ("exit" in step) {
      process.stderr.write("stand-in stopped on purpose\n");
      process.exit(step.exit);
    } else if ("stop" in step) {
      stopReason = step.stop;
    } else if ("usage" in step) {
      usage = step.usage;
    } else if ("moveModel" in step) {
      currentModel = step.moveModel;
      update(sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions() });
    }
  }
  send({ id, result: { stopReason, ...(usage ? { usage } : {}) } });
}

async function handle(message: Message): Promise<void> {
  if (message.method === undefined && message.id !== undefined) {
    const done = waiting.get(Number(message.id));
    waiting.delete(Number(message.id));
    done?.((message as { result?: unknown }).result);
    return;
  }
  const params = message.params ?? {};
  log({ method: message.method, params: redacted(params) });
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            ...((scenario.mcpHttp ?? true) === true ? { mcpCapabilities: { http: true } } : {}),
            ...(scenario.resume ? { sessionCapabilities: { resume: {} } } : {}),
          },
          ...(scenario.version ? { agentInfo: { name: "agy", version: scenario.version } } : {}),
          authMethods: [],
        },
      });
      return;
    case "session/new": {
      if (scenario.auth === "required") {
        send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
        return;
      }
      const id = `standin-${Date.now().toString(36)}`;
      servers.set(id, params.mcpServers as Http[]);
      await listWhenOpened(id);
      log({ created: id });
      send({ id: message.id, result: { sessionId: id, configOptions: configOptions() } });
      return;
    }
    case "session/resume": {
      const known = logged().some((entry) => entry.created === sessionId);
      if (!known) {
        send({ id: message.id, error: { code: -32002, message: "Session not found" } });
        return;
      }
      servers.set(sessionId, params.mcpServers as Http[]);
      await listWhenOpened(sessionId);
      send({ id: message.id, result: { configOptions: configOptions() } });
      return;
    }
    case "session/set_config_option":
      if (
        params.configId === "model" &&
        logged().filter((entry) => entry.refusedModelSet).length < (scenario.refuseModelSets ?? 0)
      ) {
        log({ refusedModelSet: params.value });
        send({ id: message.id, error: { code: -32603, message: "Model unavailable" } });
        return;
      }
      if (params.configId === "model") currentModel = String(params.value);
      send({ id: message.id, result: { configOptions: configOptions() } });
      return;
    case "session/prompt": {
      const steps = scenario.turns[promptCount] ?? [{ say: "Nothing more scripted." }];
      promptCount += 1;
      await runTurn(message.id as number, sessionId, steps);
      return;
    }
    case "session/cancel":
      cancelled?.();
      cancelled = undefined;
      return;
    default:
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: "Method not found" } });
      }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  void handle(JSON.parse(line) as Message).catch((caught: unknown) => {
    process.stderr.write(`${caught instanceof Error ? caught.message : String(caught)}\n`);
    process.exit(3);
  });
});
