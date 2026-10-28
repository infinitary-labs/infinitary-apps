import {
  frameServedInput,
  parseServedInput,
  type ServedSegment,
  type ServedSegmentInput,
} from "@shared/servedFrame";
import { decode } from "@toon-format/toon";
import { renderWake, type WakeChoice } from "../../src/core/orchestrator/wakes";
import { type CheckSnapshot, checkSnapshotSchema } from "../../src/shared/checkSnapshot";

export type ProviderContext = {
  directions?: string;
  repos: Array<{ name: string; repo_id: string; lives?: string }>;
  crew: Array<{ task_id: string; title: string; status: string }>;
  task_index: string[];
};

/**
 * One message of a provider request, whichever dialect carried it: the
 * chat completions `messages`, Anthropic's `messages` (a tool result rides
 * a user message there), or the Responses `input` items Codex's client
 * sends. Instructions (system, developer) are not the conversation.
 */
export type ProviderMessage = { role: "user" | "assistant" | "tool"; text: string };

type Part = { type?: string; text?: string; content?: unknown };
type Item = {
  type?: string;
  role?: string;
  content?: unknown;
  output?: unknown;
};

const TEXT_PARTS = new Set(["text", "input_text", "output_text"]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .flatMap((part) => (part.type && TEXT_PARTS.has(part.type) ? [part.text ?? ""] : []))
    .join("");
}

function messagesOf(item: Item): ProviderMessage[] {
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return [{ role: "tool", text: textOf(item.output) }];
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return [{ role: "assistant", text: "" }];
  }
  switch (item.role) {
    case "tool":
      return [{ role: "tool", text: textOf(item.content) }];
    case "assistant":
      return [{ role: "assistant", text: textOf(item.content) }];
    case "user": {
      const parts = Array.isArray(item.content) ? (item.content as Part[]) : [];
      const results: ProviderMessage[] = parts
        .filter((part) => part.type === "tool_result")
        .map((part) => ({ role: "tool" as const, text: textOf(part.content) }));
      const hasText =
        typeof item.content === "string" ||
        parts.some((part) => part.type !== undefined && TEXT_PARTS.has(part.type));
      return hasText ? [...results, { role: "user", text: textOf(item.content) }] : results;
    }
    default:
      return [];
  }
}

/**
 * The conversation a request carries, oldest first. Some old mock callers
 * pass a raw tail rather than a request: it has no messages to read, and
 * their full-request fallback can answer instead.
 */
export function providerMessages(body: string): ProviderMessage[] {
  if (!body.trimStart().startsWith("{")) return [];
  const request = JSON.parse(body) as { messages?: Item[]; input?: Item[] | string };
  const items = request.messages ?? (Array.isArray(request.input) ? request.input : []);
  return items.flatMap(messagesOf);
}

/** One tool call the model made earlier in a request's conversation, its arguments parsed. */
export type ProviderToolCall = { name: string; args: Record<string, unknown> };

type CallItem = Item & {
  name?: string;
  arguments?: string;
  input?: unknown;
  tool_calls?: { function?: { name?: string; arguments?: string } }[];
};

/** A call's arguments; an unreadable one throws, so a reader never misses a call. */
function parsedArgs(text: string | undefined): Record<string, unknown> {
  return (JSON.parse(text || "{}") ?? {}) as Record<string, unknown>;
}

/**
 * The tool calls a request's conversation carries, oldest first, whichever
 * dialect carried them: chat completions put them on an assistant message's
 * `tool_calls`, Anthropic's messages as `tool_use` parts, the Responses API
 * as `function_call` items. Read from the calls themselves, never from the
 * request's text, where an answer may repeat a command's words.
 */
export function providerToolCalls(body: string): ProviderToolCall[] {
  if (!body.trimStart().startsWith("{")) return [];
  const request = JSON.parse(body) as { messages?: CallItem[]; input?: CallItem[] | string };
  const items = request.messages ?? (Array.isArray(request.input) ? request.input : []);
  return items.flatMap((item): ProviderToolCall[] => {
    if (item.type === "function_call") {
      return [{ name: item.name ?? "", args: parsedArgs(item.arguments) }];
    }
    if (item.role !== "assistant") return [];
    const chat = (item.tool_calls ?? []).map((call) => ({
      name: call.function?.name ?? "",
      args: parsedArgs(call.function?.arguments),
    }));
    const parts = Array.isArray(item.content) ? (item.content as CallItem[]) : [];
    const uses = parts
      .filter((part) => part.type === "tool_use")
      .map((part) => ({
        name: part.name ?? "",
        args: (part.input ?? {}) as Record<string, unknown>,
      }));
    return [...chat, ...uses];
  });
}

/**
 * The tools a request offers the model, by name, whichever dialect carried
 * them: chat completions nest the name under `function`, Anthropic's
 * messages and the Responses API put it on the tool itself.
 */
export function requestToolNames(body: string): string[] {
  if (!body.trimStart().startsWith("{")) return [];
  const request = JSON.parse(body) as {
    tools?: { name?: string; function?: { name?: string } }[];
  };
  return (request.tools ?? []).flatMap((tool) => {
    const name = tool.function?.name ?? tool.name;
    return name ? [name] : [];
  });
}

/** Decode the wire envelope before reading host data. History is not the current board. */
export function latestContext(body: string): ProviderContext | undefined {
  const messages = providerMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ProviderMessage;
    if (message.role !== "user") continue;
    const segment = parseServedInput(message.text)?.find((part) => part.kind === "context");
    if (!segment) continue;
    // A malformed current snapshot must fail loudly, never resurrect old state.
    return decode(segment.body.slice(segment.body.indexOf("\n") + 1)) as ProviderContext;
  }
  return undefined;
}

/**
 * The request's latest input, as the host framed it, and the results of
 * its tool loop so far. Only the newest user message is read: an earlier
 * served input is history, whatever it said. An input the host did not
 * frame is no served turn at all.
 */
export type ServedTurn = { segments: ServedSegment[]; toolResults: string[] };

export function latestServedTurn(body: string): ServedTurn | undefined {
  const messages = providerMessages(body);
  let at = messages.length - 1;
  while (at >= 0 && messages[at]?.role !== "user") at -= 1;
  const segments = at >= 0 ? parseServedInput((messages[at] as ProviderMessage).text) : null;
  if (!segments) return undefined;
  return {
    segments,
    toolResults: messages
      .slice(at + 1)
      .filter((message) => message.role === "tool")
      .map((message) => message.text),
  };
}

/** A segment as the host serves it: the product's own framing, mark and all. */
export function served(segment: ServedSegmentInput): ServedSegment {
  return frameServedInput([segment]).segments[0] as ServedSegment;
}

/** Whether a served turn holds this exact segment: same kind, same origin, same body. */
export function holdsSegment(turn: ServedTurn, segment: ServedSegment): boolean {
  return turn.segments.some(
    (part) =>
      part.kind === segment.kind && part.origin === segment.origin && part.body === segment.body,
  );
}

/**
 * The captain's click on one of the Firstmate's cards, as the Firstmate is
 * served it: the facts the spec read off the card (`window.infinitary.cards`)
 * rendered by the product's own wake renderer and framed as the captain's
 * turn. The served body is prose and carries no typed facts, so the only
 * honest recognition is this: expect the whole segment the facts render to,
 * never a phrase copied out of it.
 */
export function captainCardChoice(
  card: { id: string; title: string; taskId?: string },
  choice: WakeChoice,
): ServedSegment {
  return served({
    kind: "user",
    origin: "captain",
    body: renderWake({
      facts: { kind: "card-choice", to: "firstmate", source: "chrome", card, choice },
    }),
  });
}

/** INF-1555 F12: scripted crews read the tool's typed facts, never retired readiness prose. */
export function checkFactsSnapshot(reading: string): CheckSnapshot | undefined {
  const line = reading.split("\n").find((line) => line.startsWith("facts: "));
  if (!line) return undefined;
  const facts = JSON.parse(line.slice("facts: ".length));
  return checkSnapshotSchema.parse({
    headSha: facts.headSha,
    items: facts.checks,
    complete: facts.complete ?? undefined,
    problem: facts.problem ?? undefined,
    absenceDeclared: false,
  });
}
