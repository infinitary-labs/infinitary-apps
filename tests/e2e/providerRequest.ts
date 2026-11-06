import {
  frameServedInput,
  parseServedInput,
  type ServedSegment,
  type ServedSegmentInput,
} from "@shared/servedFrame";
import { decode } from "@toon-format/toon";
import {
  PENDING_RESPONSES_END,
  PENDING_RESPONSES_OPENING,
  REQUESTED_RESPONSE_OPENING,
  RESPONSE_MISSING_OPENING,
  renderWake,
  type WakeChoice,
} from "../../src/core/orchestrator/wakes";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../../src/core/storage/sessionReader";
import { type CheckSnapshot, checkSnapshotSchema } from "../../src/shared/checkSnapshot";
import type { ScriptedCall } from "../helpers/scriptedCalls";

export type ProviderContext = {
  directions?: string;
  repos: Array<{ name: string; repo_id: string; lives?: string }>;
  /** Started work: running, idle, paused or held. */
  crew: Array<{ task_id: string; title: string; status: string }>;
  /** Unstarted work is a count; the tasks query reads it. */
  backlog?: {
    note: string;
    projects: Array<{ project: string; unstarted: number; on_request?: number }>;
  };
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

/**
 * A message's text, whichever dialect carried it: a plain string, or the
 * text parts of a content array (chat completions' and Anthropic's `text`,
 * the Responses API's `input_text` and `output_text`). Other parts, such as
 * a picture or a tool result, carry no text of their own here.
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .flatMap((part) => (part.type && TEXT_PARTS.has(part.type) ? [part.text ?? ""] : []))
    .join("");
}

function messagesOf(item: Item): ProviderMessage[] {
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return [{ role: "tool", text: messageText(item.output) }];
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return [{ role: "assistant", text: "" }];
  }
  switch (item.role) {
    case "tool":
      return [{ role: "tool", text: messageText(item.content) }];
    case "assistant":
      return [{ role: "assistant", text: messageText(item.content) }];
    case "user": {
      const parts = Array.isArray(item.content) ? (item.content as Part[]) : [];
      const results: ProviderMessage[] = parts
        .filter((part) => part.type === "tool_result")
        .map((part) => ({ role: "tool" as const, text: messageText(part.content) }));
      const hasText =
        typeof item.content === "string" ||
        parts.some((part) => part.type !== undefined && TEXT_PARTS.has(part.type));
      return hasText ? [...results, { role: "user", text: messageText(item.content) }] : results;
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

/** The id each row section keys its rows by, as the first mate renders them. */
const ROW_IDS: Record<string, string> = {
  repos: "repo_id",
  crew: "task_id",
  open_cards: "card_id",
  schedules: "id",
};

/** Facts of one input alone: the next input's own replace them, or they are gone. */
const TURN_ONLY = [
  "delivery",
  "as_of",
  "knowledge",
  "captain_resolutions",
  "thread_activity",
  "visible_card_hint",
  "about",
  "focused_project",
  "recovery",
];

type Fold = Record<string, unknown>;

/**
 * Apply one served context to what the model holds (INF-1712,
 * docs/orchestrator-contract.md "What a context carries"): a complete one
 * replaces it; changes replace rows by id, drop removed ids and sections,
 * and replace whole sections.
 */
function foldContext(held: Fold, context: Fold): Fold {
  if (String(context.delivery ?? "").startsWith("complete")) return { ...context };
  const next: Fold = Object.fromEntries(
    Object.entries(held).filter(([name]) => !TURN_ONLY.includes(name)),
  );
  for (const name of (context.removed_sections as string[] | undefined) ?? []) delete next[name];
  for (const [name, value] of Object.entries(context)) {
    if (name === "removed_sections") continue;
    const id = ROW_IDS[name];
    const change = value as { changed?: Fold[]; removed?: string[] } | undefined;
    if (!id || Array.isArray(value) || !change || typeof change !== "object") {
      next[name] = value;
      continue;
    }
    const rows = ((next[name] as Fold[] | undefined) ?? []).filter(
      (row) => !change.removed?.includes(String(row[id])),
    );
    for (const row of change.changed ?? []) {
      const at = rows.findIndex((held) => held[id] === row[id]);
      if (at >= 0) rows[at] = row;
      else rows.push(row);
    }
    next[name] = rows;
  }
  return next;
}

/**
 * Decode the wire envelope before reading host data: every context the
 * request carries, folded in order, is what the model holds when it reads
 * the newest. A request with no context holds none.
 */
export function latestContext(body: string): ProviderContext | undefined {
  let held: Fold | undefined;
  for (const message of providerMessages(body)) {
    if (message.role !== "user") continue;
    const segment = parseServedInput(message.text)?.find((part) => part.kind === "context");
    if (!segment) continue;
    // A malformed snapshot must fail loudly, never resurrect old state.
    const context = decode(segment.body.slice(segment.body.indexOf("\n") + 1)) as Fold;
    held = foldContext(held ?? {}, context);
  }
  return held as ProviderContext | undefined;
}

/**
 * The newest context the request carries, alone: what that one input sent,
 * not what the model holds. Reads a fact that goes only when it changed.
 */
export function servedContext(body: string): Record<string, unknown> | undefined {
  const messages = providerMessages(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ProviderMessage;
    if (message.role !== "user") continue;
    const segment = parseServedInput(message.text)?.find((part) => part.kind === "context");
    if (!segment) continue;
    return decode(segment.body.slice(segment.body.indexOf("\n") + 1)) as Record<string, unknown>;
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

/**
 * INF-2214: these generic operational notices acknowledge delivery, not a
 * new assignment. Preserve the raw provider request for evidence; only the
 * deterministic stand-in's scenario routing omits their quoted old commands.
 */
export function scriptedResponseInput(
  body: string,
  worker = false,
): { body: string; onlyNotices: boolean } {
  const notice = (segment: ServedSegment) =>
    segment.kind === "wake" &&
    [REQUESTED_RESPONSE_OPENING, RESPONSE_MISSING_OPENING].some((opening) =>
      segment.body.startsWith(opening),
    );
  const latest =
    latestServedTurn(body)?.segments.filter((segment) => segment.kind !== "context") ?? [];
  const onlyNotices = !worker && latest.length > 0 && latest.every(notice);
  let changed = false;
  const text = (value: string): string => {
    // A worker's snapshot can quote earlier commands. It is context, not
    // another current instruction. Keep following review-assignment text.
    let input = value;
    if (worker) {
      const start = input.indexOf(PENDING_RESPONSES_OPENING);
      const end = start < 0 ? -1 : input.indexOf(PENDING_RESPONSES_END, start);
      if (end >= 0) {
        input = input.slice(0, start) + input.slice(end + PENDING_RESPONSES_END.length);
        changed = true;
      }
    }
    const segments = parseServedInput(input);
    if (!segments?.some(notice)) return input;
    changed = true;
    return frameServedInput(
      segments
        .filter((segment) => !notice(segment))
        .map(
          (segment): ServedSegmentInput =>
            segment.kind === "context"
              ? { kind: "context", body: segment.body }
              : segment.kind === "user"
                ? { kind: "user", origin: "captain", body: segment.body }
                : {
                    kind: "wake",
                    origin: segment.origin === "captain" ? "agent" : (segment.origin ?? "agent"),
                    body: segment.body,
                  },
        ),
    ).text;
  };
  const request = JSON.parse(body) as { messages?: Item[]; input?: Item[] | string };
  const items = request.messages ?? (Array.isArray(request.input) ? request.input : []);
  for (const item of items) {
    if (item.role !== "user") continue;
    if (typeof item.content === "string") item.content = text(item.content);
    else if (Array.isArray(item.content))
      item.content = (item.content as Part[]).map((part) =>
        part.type && TEXT_PARTS.has(part.type) && typeof part.text === "string"
          ? { ...part, text: text(part.text) }
          : part,
      );
  }
  return { body: changed ? JSON.stringify(request) : body, onlyNotices };
}

/** A chat completions request, as the readers below parse one: its messages alone. */
export type ChatRequest = { messages?: { role: string; content?: unknown }[] };

/**
 * A message's tool results, in order: a `tool` message's text, or the
 * `tool_result` blocks the Anthropic dialect carries in a user message.
 */
export function toolResults(message: { role: string; content?: unknown }): string[] {
  return messagesOf(message as Item)
    .filter((read) => read.role === "tool")
    .map((read) => read.text);
}

/** A note Claude's client adds to a message on its own (`<system-reminder>`), never anyone's words. */
const CLIENT_NOTE = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

/** A message's text, the client's own notes aside. */
function saidIn(content: unknown): string {
  if (!Array.isArray(content)) return messageText(content);
  return messageText(
    content.filter((part) => !CLIENT_NOTE.test((part as { text?: string }).text ?? "")),
  );
}

/**
 * The newest user message's text and the tool results that followed it, in
 * order. A user message that carries tool results and nobody's words (the
 * Anthropic dialect's) is a step of that turn, not a new one.
 */
export function sinceLastUser(body: string): { user: string; results: string[]; tail: string } {
  if (!body.trimStart().startsWith("{")) return { user: "", results: [], tail: "" };
  const messages = (JSON.parse(body) as ChatRequest).messages ?? [];
  let at = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const step = message && toolResults(message).length > 0 && !saidIn(message.content);
    if (message?.role === "user" && !step) {
      at = index;
      break;
    }
  }
  if (at < 0) return { user: "", results: [], tail: "" };
  return {
    user: messageText(messages[at]?.content),
    tail: JSON.stringify(messages.slice(at)),
    results: messages.slice(at + 1).flatMap(toolResults),
  };
}

/** The instructions a request carries (system or developer), whichever dialect. */
export function servedInstructions(body: string): string {
  if (!body.trimStart().startsWith("{")) return "";
  const request = JSON.parse(body) as {
    system?: unknown;
    instructions?: unknown;
    messages?: { role: string; content?: unknown }[];
  };
  const roles = new Set(["system", "developer"]);
  return [
    request.system,
    request.instructions,
    ...(request.messages ?? []).filter((m) => roles.has(m.role)).map((m) => m.content),
  ]
    .map(messageText)
    .join("\n");
}

/**
 * The captain message a reply's served words name - a crewmate's thread
 * steer ("This is the captain's message N") or the first mate's about line
 * ("replied in its thread as message N") - as `answers_message`, which a
 * real answer passes: only a line naming it ends the captain's question
 * (the captain's "Only a line that says it answers it; a handoff stays
 * open"). Empty when the words name none, so an acknowledgement stays unnamed.
 */
export function answering(served: string): { answers_message?: number } {
  const named = [
    ...served.matchAll(/(?:This is the captain's message|replied in its thread as message) (\d+)/g),
  ].at(-1)?.[1];
  return named ? { answers_message: Number(named) } : {};
}

/** Whether the conversation so far carries a CALL of the named tool (not its definition). */
export function calledTool(body: string, name: string): boolean {
  return toolCallCount(body, name) > 0;
}

/**
 * How many CALLs of the named tool the conversation so far carries (not its
 * definition), under the app's own name or the prefixed one Claude's client
 * serves an in-process tool under (`CLAUDE_SEAT_TOOL_PREFIX`).
 */
export function toolCallCount(body: string, name: string): number {
  let count = 0;
  for (const served of [name, `${CLAUDE_SEAT_TOOL_PREFIX}${name}`]) {
    for (const call of [
      `"name":"${served}","arguments"`,
      `"name": "${served}", "arguments"`,
      // Anthropic messages calls carry `input`; definitions carry `input_schema`.
      `"name":"${served}","input":`,
      `"name": "${served}", "input":`,
    ]) {
      count += body.split(call).length - 1;
    }
  }
  return count;
}

function contextCrew(body: string) {
  return latestContext(body)?.crew ?? [];
}

/** The context's repos, as name and id pairs. */
export function contextRepos(body: string): Array<[name: string, id: string]> {
  return (latestContext(body)?.repos ?? []).map((repo) => [repo.name, repo.repo_id]);
}

/** A started task's id off the context's crew, by a phrase its title holds. */
export function findCrewTaskId(body: string, titleNeedle: string): string | undefined {
  const needle = titleNeedle.trim();
  return needle
    ? contextCrew(body).find((entry) => entry.title.includes(needle))?.task_id
    : undefined;
}

/** A started task's id off the context's crew, by its exact title. */
export function indexTaskId(body: string, title: string): string | undefined {
  return contextCrew(body).find((entry) => entry.title === title)?.task_id;
}

/** A task's id off a `tasks` read's result, by its exact title. */
function queriedTaskId(result: string | undefined, title: string): string | undefined {
  const start = result?.indexOf("[") ?? -1;
  if (!result || start < 0) return undefined;
  const end = result.lastIndexOf("]");
  const rows = JSON.parse(result.slice(start, end + 1)) as Array<{
    task_id: string;
    title: string;
  }>;
  return rows.find((row) => row.title === title)?.task_id;
}

/**
 * Unstarted work is not in the context (INF-1712): the first mate reads it
 * with `tasks` by its title, then makes the call that names it. Undefined
 * once both went out; the caller's later moves count two results more.
 */
export function lookUpTask(
  title: string,
  results: string[],
  then: (taskId: string) => ScriptedCall[],
): { calls: ScriptedCall[] } | undefined {
  if (results.length === 0) return { calls: [{ name: "tasks", args: { text: title } }] };
  if (results.length === 1) return { calls: then(queriedTaskId(results[0], title) ?? "missing") };
  return undefined;
}
