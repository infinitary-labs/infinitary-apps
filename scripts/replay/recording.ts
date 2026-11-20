/**
 * The recording a replay plays (`./engine.ts`): the Firstmate's recorded
 * turns and each crewmate's recorded session, read through the one session
 * reader, and the refs a recorded answer is matched to a live wake by.
 */

import type { WakeFacts } from "../../src/core/orchestrator/wakes.ts";
import { CLIENT_NOTICE, readSession } from "../../src/core/storage/sessionReader.ts";
import { parseServedInput, type ServedOrigin } from "../../src/shared/servedFrame.ts";
import {
  type DispatchTurn,
  extractTurnsFromJsonl,
  parseContextBlock,
} from "../dispatch-corpus/dispatchTurns.ts";
import { type ReplayWindow, windowEntries, windowJsonlText } from "./window.ts";

export type JsonRecord = Record<string, unknown>;

export type RecordedCall = {
  name: string;
  args: JsonRecord;
  result: { text: string; isError: boolean } | undefined;
};

export type RecordedFirstmateTurn = {
  at: number;
  kind: "captain" | "op";
  user: string;
  payloads: string[];
  normalized: string[];
  refs: string[];
  calls: RecordedCall[];
  closing: string;
  failed: boolean;
  error: string | null;
  fleet: ReturnType<typeof parseContextBlock> | null;
  consumed: boolean;
};

export type CrewPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; args: JsonRecord };

export type CrewSegment = {
  at: number;
  user: string;
  messages: { parts: CrewPart[]; error: string | null }[];
  results: Map<string, string>;
};

export type CrewRecording = { alias: string; segments: CrewSegment[]; cancelAt: number | null };

/** A recorded answer may be matched to a wake at most this far ahead of it. */
export const MATCH_LOOKAHEAD_MS = 10 * 60_000;

/**
 * The same wake with host wording appended or trimmed (an answer-owner hint,
 * an overflow note): one normalized text starts with the other.
 */
export function samePrefix(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 40 && long.startsWith(short);
}

/**
 * What a current Firstmate prompt carries: the captain's words (null for an
 * operational drain) and the wakes before them. A framed input (R2) is read
 * by its segments; historical text by its delimiters.
 */
export function firstmatePromptParts(text: string): { user: string | null; payloads: string[] } {
  const framed = parseServedInput(text);
  if (framed) {
    const words = framed
      .filter((segment) => segment.kind === "user")
      .map((segment) => segment.body.replace(/^\[user\]\n/, "").trim());
    return {
      user: words.length > 0 ? words.join("\n\n") : null,
      payloads: framed
        .filter((segment) => segment.kind === "wake")
        .map((segment) => segment.body.trim())
        .filter(Boolean),
    };
  }
  const marker = "\n\n[user]\n";
  const userAt = text.lastIndexOf(marker);
  const pre = userAt >= 0 ? text.slice(0, userAt) : text;
  const split = pre.indexOf("\n\n");
  return {
    user: userAt >= 0 ? text.slice(userAt + marker.length).trim() : null,
    payloads: splitPayloads(split >= 0 ? pre.slice(split + 2) : pre),
  };
}

function splitPayloads(text: string): string[] {
  return text
    .split(/\n\n(?=\[fm-op\] )/)
    .map((payload) => payload.trim())
    .filter(Boolean);
}

/** Wording that differs run to run and carries no meaning for matching. */
export function normalizeWording(text: string): string {
  return text
    .replace(/crewmate \d+/g, "crewmate")
    .replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, "KEY")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The kind of wake and what it is about, for matching a recorded answer to a
 * wake whose wording the current code changed.
 */
export function wakeRef(payload: string): string {
  const task = (pattern: RegExp) => pattern.exec(payload)?.[1] ?? "";
  // Answer receipts are structured recordings, not prose to classify. Match the
  // same task/choice even when the live renderer adds a recovery instruction.
  if (payload.startsWith("[fm-op] {")) {
    try {
      const receipt = JSON.parse(payload.slice("[fm-op] ".length));
      if (receipt.event === "answer_task_closed" && typeof receipt.task?.id === "string" && typeof receipt.choice?.id === "string")
        return `answer-closed:${receipt.task.id}:${receipt.choice.id}`;
    } catch {}
  }
  if (/^\[fm-op\] fleet event escalated to you/.test(payload)) {
    return `escalated:${task(/escalated to you \(task ([^)\s]+)\)/)}`;
  }
  if (/ reported on task /.test(payload)) return `reported:${task(/reported on task (\S+)/)}`;
  if (/'s turn on task \S+ .* failed:/s.test(payload)) {
    return `turn-failed:${task(/turn on task (\S+)/)}`;
  }
  if (/ was interrupted on task /.test(payload)) {
    return `interrupted:${task(/interrupted on task (\S+)/)}`;
  }
  if (/filed a follow-up while working on task/.test(payload)) {
    return `followup:${task(/working on task (\S+)/)}`;
  }
  if (/^\[fm-op\] task \S+ ".*" failed:/s.test(payload)) {
    return `task-failed:${task(/^\[fm-op\] task (\S+)/)}`;
  }
  if (/the user chose/.test(payload)) return `chose:${task(/card "([^"]*)"/)}`;
  if (/dismissed the card/.test(payload)) return `dismissed:${task(/card "([^"]*)"/)}`;
  if (/deferred your card/.test(payload)) return `deferred:${task(/card "([^"]*)"/)}`;
  if (/guidance/.test(payload)) return `guidance:${task(/task (\S+)/)}`;
  if (/\bjob\b/.test(payload)) return `job:${task(/task (\S+)/)}`;
  return "other:";
}

/**
 * Every ref a wake may be matched by, widest last. The one alias S7c needs:
 * before it, a report the Firstmate heard about arrived wearing the retired
 * session's "fleet event escalated to you (task X)" wording, because that
 * session was the only thing that could hand one over. The whose-turn rule
 * hands over the report itself, so the same moment in the same recording
 * reads `reported:X` now and `escalated:X` in the recording. Matching one
 * to the other is the same kind-and-task fallback the engine already uses;
 * it changes no product behaviour and invents no answer.
 */
export function wakeRefAliases(payload: string): string[] {
  return refAliases(wakeRef(payload));
}

export function refAliases(ref: string): string[] {
  const reported = /^reported:(.+)$/.exec(ref);
  return reported ? [ref, `escalated:${reported[1]}`] : [ref];
}

/**
 * The kind of a LIVE wake and what it is about, read off its typed facts
 * (the primitives review P6) in the recorded half's vocabulary (`wakeRef`),
 * so a live wake is classified by what the host knew and the recordings,
 * which are text, still by their words. A kind the recordings have no word
 * for has no ref: it matches a recorded answer by its text alone. An
 * outage's first failure is the failed turn a recording of that moment
 * spoke of. `name` puts a live id or title into the recorded half's terms.
 */
export function factsWakeRef(
  facts: WakeFacts,
  name: (text: string) => string = (text) => text,
): string | null {
  switch (facts.kind) {
    case "answer-closed":
      return `answer-closed:${name(facts.handoff.task.id)}:${facts.handoff.choice.id}`;
    case "report":
      return `reported:${name(facts.task.id)}`;
    case "turn-failed":
    case "outage-failed":
      return `turn-failed:${name(facts.task.id)}`;
    case "task-failed":
      return `task-failed:${name(facts.task.id)}`;
    case "job-bound":
      return `job:${name(facts.task.id)}`;
    case "guidance-set-aside":
      return `guidance:${name(facts.task.id)}`;
    case "card-choice":
      return `chose:${name(facts.card.title)}`;
    default:
      return null;
  }
}

/**
 * The live wakes whose task a closed record makes a wake after a cancel:
 * a report and a failed turn, as the recorded half's words name them.
 */
export const TASK_WAKE_KINDS: ReadonlySet<WakeFacts["kind"]> = new Set([
  "report",
  "turn-failed",
  "outage-failed",
]);

/** One live wake a Firstmate turn was served, with the typed facts of the row it came from. */
export type LiveWake = { payload: string; facts: WakeFacts | null; origin: ServedOrigin | null };

function firstmateTurnFrom(turn: DispatchTurn): RecordedFirstmateTurn | null {
  let kind: "captain" | "op";
  let user = "";
  let payloads: string[] = [];
  if (turn.kind === "op" && turn.op) {
    kind = "op";
    payloads = splitPayloads(turn.op);
  } else if (turn.user) {
    kind = "captain";
    user = turn.user;
  } else if (turn.context) {
    // A drained [fm-op] batch rides behind the context block with no [user]
    // marker, so the extractor reads it as an empty captain turn.
    const split = turn.context.indexOf("\n\n");
    if (split < 0) return null;
    kind = "op";
    payloads = splitPayloads(turn.context.slice(split + 2));
  } else {
    return null;
  }
  if (kind === "op" && payloads.length === 0) return null;
  const normalized = payloads.map(normalizeWording);
  return {
    at: turn.at,
    kind,
    user,
    payloads,
    normalized,
    refs: normalized.map(wakeRef),
    calls: turn.calls.map((call) => ({ name: call.name, args: call.args, result: call.result })),
    closing: turn.assistant.trim().split("\n").pop() ?? "",
    failed: turn.turnFailed,
    error: turn.error,
    fleet: turn.fleet,
    consumed: false,
  };
}

function timestampOf(entry: JsonRecord): number {
  const value = entry.timestamp;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as JsonRecord).type === "text"
        ? String((part as JsonRecord).text ?? "")
        : "",
    )
    .join("");
}

/**
 * The Firstmate's recorded turns across its session files, in recorded
 * order: the captain's turns and the operational drains. Every file is read
 * through the one session reader, so a Claude-served session
 * replays exactly as a Pi one holding the same turns.
 */
export function readFirstmateRecording(
  files: string[],
  window: ReplayWindow | null = null,
): { captain: RecordedFirstmateTurn[]; op: RecordedFirstmateTurn[] } {
  const captain: RecordedFirstmateTurn[] = [];
  const op: RecordedFirstmateTurn[] = [];
  for (const file of [...files].sort()) {
    const text = windowJsonlText(readSession(file).text, window);
    for (const turn of extractTurnsFromJsonl(text, file)) {
      const recorded = firstmateTurnFrom(turn);
      if (!recorded) continue;
      (recorded.kind === "captain" ? captain : op).push(recorded);
    }
  }
  captain.sort((a, b) => a.at - b.at);
  op.sort((a, b) => a.at - b.at);
  return { captain, op };
}

export function readCrewRecording(
  alias: string,
  files: string[],
  window: ReplayWindow | null = null,
): CrewRecording {
  const segments: CrewSegment[] = [];
  let cancelAt: number | null = null;
  for (const file of [...files].sort()) {
    // Through the one session reader, so a Claude-served crewmate's copy
    // plays exactly as a Pi one holding the same turns.
    const read = readSession(file);
    const entries = window
      ? windowEntries(read.text, window).map((item) => item.entry)
      : read.entries;
    for (const entry of entries) {
      if (entry.type === "replay_control" && entry.action === "cancel") {
        cancelAt = timestampOf(entry);
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message as JsonRecord | undefined;
      if (!message) continue;
      // A Claude client's own notice (one of its background commands
      // finished) was served by nobody: the turn carried on by itself, so
      // it plays as the running segment rather than waiting for an input
      // the host never gave.
      if (message.role === "user" && message.commandMode === CLIENT_NOTICE && segments.length > 0) {
        continue;
      }
      if (message.role === "user") {
        segments.push({
          at: timestampOf(entry),
          user: textOf(message.content),
          messages: [],
          results: new Map(),
        });
        continue;
      }
      const segment = segments.at(-1);
      if (!segment) continue;
      if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        segment.results.set(message.toolCallId, textOf(message.content));
        continue;
      }
      if (message.role !== "assistant") continue;
      const parts: CrewPart[] = [];
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const typed = part as JsonRecord;
        if (typed.type === "text" && typeof typed.text === "string") {
          parts.push({ type: "text", text: typed.text });
        } else if (typed.type === "toolCall" && typeof typed.name === "string") {
          parts.push({
            type: "toolCall",
            id: typeof typed.id === "string" ? typed.id : "",
            name: typed.name,
            args: (typed.arguments as JsonRecord) ?? {},
          });
        }
      }
      segment.messages.push({
        parts,
        error:
          message.stopReason === "error"
            ? typeof message.errorMessage === "string"
              ? message.errorMessage
              : "error"
            : null,
      });
    }
  }
  return { alias, segments, cancelAt };
}
