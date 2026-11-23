import { basename } from "node:path";
import {
  CREW_CALL_TEXT_MAX,
  CREW_DIFF_LINES_MAX,
  CREW_RESULT_TEXT_MAX,
  CREW_TEXT_MAX,
  CREW_TRANSCRIPT_LINES_MAX,
  type CrewDiff,
  type CrewDiffLine,
  type CrewLine,
  type CrewLive,
  type CrewPicture,
  type CrewPictureRef,
  type CrewResult,
  type CrewResultText,
  type CrewSender,
  type CrewTranscript,
} from "@shared/crewTranscript";
import type { FmEvent } from "@shared/events";
import { planItemStateSchema } from "@shared/taskPlan";
import { cutText, cutTextEnd } from "@shared/textCut";
import { runsTaskCommand, taskCommandShown } from "../axi/names";
import { redactObserveText } from "../observe/redact";
import {
  CLIENT_INTERRUPT_NOTICE,
  CLIENT_NOTICE,
  SessionFollower,
  sessionFilesIn,
} from "../storage/sessionReader";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { actionText } from "./crewActions";

type JsonRecord = Record<string, unknown>;

/**
 * The app's own tools whose calls the Crewmate tab draws as blocks rather
 * than as calls (docs/task-card-tabs.md, "The Crewmate tab"): the plan a
 * progress note carries, a report, a card, the pull request. Named as the
 * tools name themselves (`crewTranscript.test.ts` holds them to the tools).
 */
export const CREW_BLOCK_TOOLS = {
  plan: "note_progress",
  report: "report",
  card: "emit_card",
  change: "open_change",
} as const;

export type CrewTranscriptsOptions = {
  /** Where the app keeps a task's sessions (`crewmates/<task>/sessions/`). */
  recordDirOf: (taskId: string) => string;
  /**
   * The file holding the session the crewmate runs now, when it is not the
   * copy in its record dir: a Claude client's own file while it holds a
   * turn's tail the copy has not caught up with yet.
   */
  currentSession?: (task: TaskRecord) => string | null;
};

/** How many session files the reader follows at once, the least recently read let go first. */
const FOLLOWED_MAX = 16;

/**
 * A crewmate's sessions read as its Crewmate tab's transcript, at each read
 * and never stored (docs/task-card-tabs.md, "The Crewmate tab"). Each
 * session is followed as it grows through the one session reader
 * (`SessionFollower`), so a long session costs one parse; a transcript
 * whose sessions and record have not moved since the last read is the same
 * one. A session's generation is its follower's, which no other follower
 * shares, so the Claude client's own file standing in for the app's copy of
 * it, or the copy taking its place again, moves the transcript too.
 */
export class CrewTranscripts {
  private readonly followed = new Map<string, SessionFollower>();
  private readonly built = new Map<string, CrewTranscript>();

  constructor(private readonly options: CrewTranscriptsOptions) {}

  /**
   * The transcript of the task's crewmate: its sessions, oldest first, with
   * the lines it was sent told apart by the record's own `steered` events,
   * and the ones the captain sent that its session does not hold yet at the
   * end, queued. `events` is the task's timeline.
   */
  of(task: TaskRecord, events: readonly TaskEvent[], closed: boolean): CrewTranscript {
    const sessions = this.files(task).map((path) => ({ path, ...this.follower(path).read() }));
    const steers = events.filter((event) => event.kind === "steered");
    const stops = events.filter(
      (event) => event.kind === "interrupted" && event.data?.effect === "aborted-turn",
    );
    const revision = [
      ...sessions.map((session) => `${basename(session.path)}:${session.generation}`),
      `s${steers.length}:${steers.at(-1)?.id ?? 0}`,
      `i${stops.length}`,
      closed ? "closed" : "open",
    ].join("|");
    const held = this.built.get(task.id);
    if (held?.revision === revision) return held;
    const ordered = [...sessions].sort(
      (a, b) =>
        (startOf(a.entries) ?? Number.POSITIVE_INFINITY) -
          (startOf(b.entries) ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path),
    );
    const lines = transcriptLines(
      ordered.map((session) => ({ file: basename(session.path), entries: session.entries })),
      task.worktreeDir,
      steers,
      stops,
      closed,
    );
    const earlier = Math.max(0, lines.length - CREW_TRANSCRIPT_LINES_MAX);
    const transcript: CrewTranscript = {
      taskId: task.id,
      earlier,
      lines: earlier > 0 ? lines.slice(earlier) : lines,
      revision,
    };
    this.built.delete(task.id);
    this.built.set(task.id, transcript);
    if (this.built.size > FOLLOWED_MAX) {
      const oldest = this.built.keys().next().value;
      if (oldest !== undefined) this.built.delete(oldest);
    }
    return transcript;
  }

  /** A call's whole result, by the ref its line carries, cut at its bound; null when it is gone. */
  result(task: TaskRecord, ref: string): CrewResultText | null {
    const entry = this.entryAt(task, ref);
    const message = entry?.message as JsonRecord | undefined;
    if (message?.role !== "toolResult") return null;
    const text = redactObserveText(textOf(message.content)).replace(/\s+$/, "");
    return {
      text: cutText(text, CREW_RESULT_TEXT_MAX),
      cut: Math.max(0, text.length - CREW_RESULT_TEXT_MAX),
    };
  }

  /** A picture a call's result holds, by the ref its line carries; null when it is gone. */
  picture(task: TaskRecord, ref: string): CrewPicture | null {
    const last = ref.lastIndexOf("#");
    if (last <= 0) return null;
    const content = (this.entryAt(task, ref.slice(0, last))?.message as JsonRecord | undefined)
      ?.content;
    const image = Array.isArray(content)
      ? (content[Number(ref.slice(last + 1))] as JsonRecord | undefined)
      : undefined;
    if (image?.type !== "image" || typeof image.data !== "string") return null;
    return {
      mimeType: typeof image.mimeType === "string" ? image.mimeType : "image/png",
      data: image.data,
    };
  }

  /** The entry a `<file>#<entry id>` ref names in the task's sessions; the file never holds a `#`. */
  private entryAt(task: TaskRecord, ref: string): JsonRecord | undefined {
    const split = ref.indexOf("#");
    if (split <= 0) return undefined;
    const file = ref.slice(0, split);
    const entryId = ref.slice(split + 1);
    const path = this.files(task).find((candidate) => basename(candidate) === file);
    if (!path) return undefined;
    const { entries } = this.follower(path).read();
    return entries.find((candidate, index) => entryIdOf(candidate, index) === entryId);
  }

  private files(task: TaskRecord): string[] {
    const files = sessionFilesIn(this.options.recordDirOf(task.id));
    const current = this.options.currentSession?.(task) ?? null;
    if (!current || files.includes(current)) return files;
    // The same session, further along: it stands in for the copy of it.
    return [...files.filter((file) => basename(file) !== basename(current)), current];
  }

  private follower(path: string): SessionFollower {
    let follower = this.followed.get(path);
    if (follower) this.followed.delete(path);
    else follower = new SessionFollower(path);
    this.followed.set(path, follower);
    if (this.followed.size > FOLLOWED_MAX) {
      const oldest = this.followed.keys().next().value;
      if (oldest !== undefined) this.followed.delete(oldest);
    }
    return follower;
  }
}

const LIVE_TEXT_MAX = 16_000;

/**
 * What each crewmate is writing in its running turn, before its session
 * holds it: the text since its last call, cleared at each call and at the
 * turn's end, when the session has it. Fed from the one event seam.
 */
export class CrewLiveText {
  private readonly text = new Map<string, string>();

  apply(event: FmEvent): void {
    switch (event.type) {
      case "assistant_delta": {
        const current = this.text.get(event.taskId) ?? "";
        this.text.set(event.taskId, cutTextEnd(current + event.text, LIVE_TEXT_MAX));
        return;
      }
      case "tool_start":
      case "tool_end":
      case "turn_end":
      case "turn_failed":
      case "task_finished":
        this.text.delete(event.taskId);
        return;
      default:
        return;
    }
  }

  read(taskId: string, since: number | null): CrewLive {
    return { taskId, text: redactObserveText(this.text.get(taskId) ?? ""), since };
  }
}

type SessionEntries = { file: string; entries: readonly JsonRecord[] };

/** The lines of a crewmate's sessions, oldest first, with what its record says about them. */
export function transcriptLines(
  sessions: readonly SessionEntries[],
  worktree: string,
  steers: readonly TaskEvent[],
  stops: readonly TaskEvent[],
  closed: boolean,
): CrewLine[] {
  const lines: CrewLine[] = [];
  const calls = new Map<string, Extract<CrewLine, { kind: "tool" }>>();
  const delivered = new Set<number>();
  /** The newest time a prompt reached the crewmate: a later steer is still on its way. */
  let lastPrompt = Number.NEGATIVE_INFINITY;
  let briefed = false;
  let clock = 0;
  for (const { file, entries } of sessions) {
    entries.forEach((entry, index) => {
      const at = timeOf(entry) ?? clock;
      clock = Math.max(clock, at);
      const id = `${file}#${entryIdOf(entry, index)}`;
      if (entry.type === "compaction") {
        lines.push({ kind: "compacted", id, at });
        return;
      }
      if (entry.type !== "message") return;
      const message = entry.message as JsonRecord | undefined;
      if (!message) return;
      if (message.role === "user") {
        // The client's own notices - one of its background commands finished,
        // a turn was interrupted - are nobody's words: the record says the rest.
        if (message.commandMode === CLIENT_NOTICE) return;
        const text = textOf(message.content).trim();
        if (!text || CLIENT_INTERRUPT_NOTICE.test(text)) return;
        lastPrompt = Math.max(lastPrompt, at);
        if (!briefed) {
          briefed = true;
          lines.push({ kind: "brief", id, at, text: bounded(redactObserveText(text)) });
          return;
        }
        lines.push(...sentLines(id, at, text, steers, delivered));
        return;
      }
      if (message.role === "assistant") {
        const content = Array.isArray(message.content) ? (message.content as JsonRecord[]) : [];
        let words = "";
        const flush = (part: number) => {
          const said = words.trim();
          words = "";
          if (said) {
            lines.push({
              kind: "said",
              id: `${id}#${part}`,
              at,
              text: bounded(redactObserveText(said)),
            });
          }
        };
        content.forEach((part, partIndex) => {
          if (part.type === "text" && typeof part.text === "string") {
            words += `${words ? "\n\n" : ""}${part.text}`;
            return;
          }
          if (part.type !== "toolCall" || typeof part.name !== "string") return;
          flush(partIndex);
          const callId = typeof part.id === "string" && part.id ? part.id : `${id}#${partIndex}`;
          const args = (
            part.arguments && typeof part.arguments === "object" ? part.arguments : {}
          ) as JsonRecord;
          const block = blockLine(part.name, args, `${id}#${partIndex}`, at);
          if (block) {
            lines.push(block);
            return;
          }
          const line = callLine(part.name, args, callId, at, worktree);
          calls.set(callId, line);
          lines.push(line);
        });
        flush(content.length);
        if (message.stopReason === "error") {
          const error =
            typeof message.errorMessage === "string" ? message.errorMessage : "The turn failed.";
          lines.push({ kind: "failed", id: `${id}#error`, at, text: redactObserveText(error) });
        }
        return;
      }
      if (message.role === "toolResult") {
        const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        const call = calls.get(callId);
        if (!call) return;
        call.result = resultOf(message, `${file}#${entryIdOf(entry, index)}`);
      }
    });
  }
  for (const stop of stops) {
    placeByTime(lines, {
      kind: "stopped",
      id: `stop#${stop.id}`,
      at: stop.at,
      by: senderOf(stop),
    });
  }
  // A line the captain sent that the session does not hold: on its way while
  // no prompt reached the crewmate after it, else it went out in other words.
  for (const steer of steers) {
    if (delivered.has(steer.id) || steer.actor !== "captain") continue;
    const line = steerLine(steer, `steer#${steer.id}`, steer.at, false);
    if (!closed && steer.at >= lastPrompt) lines.push({ ...line, queued: true });
    else placeByTime(lines, line);
  }
  return lines;
}

/**
 * The lines one prompt the crewmate was sent reads as: each steer the
 * record holds whose words it carries, by who sent it, or one line from the
 * app when no steer names it (a wake the host sent itself). The record's
 * steer is the steer's whole text, so this is a match on exact words the
 * host wrote, never a reading of them.
 */
function sentLines(
  id: string,
  at: number,
  text: string,
  steers: readonly TaskEvent[],
  delivered: Set<number>,
): CrewLine[] {
  const carries = (steer: TaskEvent) => steer.text.trim() && text.includes(steer.text.trim());
  const fresh = steers.filter((steer) => !delivered.has(steer.id) && carries(steer));
  // A steer the crewmate was sent again - a turn's end took it back and sent it
  // as the next turn - reads as its sender's line again, never as the app's.
  const carried = fresh.length > 0 ? fresh : steers.filter(carries);
  if (carried.length === 0) {
    return [
      { kind: "sent", id, at, from: "app", text: bounded(redactObserveText(text)), queued: false },
    ];
  }
  return carried.map((steer, index) => {
    delivered.add(steer.id);
    return steerLine(steer, carried.length === 1 ? id : `${id}#${index}`, at, false);
  });
}

function steerLine(
  steer: TaskEvent,
  id: string,
  at: number,
  queued: boolean,
): Extract<CrewLine, { kind: "sent" }> {
  const from = senderOf(steer);
  const via = steer.data?.via;
  return {
    kind: "sent",
    id,
    at,
    from,
    text: bounded(redactObserveText(captainWords(steer) ?? steer.text)),
    queued,
    ...(from === "captain"
      ? { via: via === "crewmate-tab" ? "crewmate-tab" : via === "thread" ? "thread" : "other" }
      : {}),
  };
}

function senderOf(event: TaskEvent): CrewSender {
  return event.actor === "captain" ? "captain" : event.actor === "firstmate" ? "firstmate" : "app";
}

/** The captain's own words in a steer that carries them (`SteerEventData.words`). */
function captainWords(steer: TaskEvent): string | undefined {
  const span = steer.data?.words as { from?: unknown; to?: unknown } | undefined;
  if (!span || typeof span.from !== "number" || typeof span.to !== "number") return undefined;
  if (span.from > span.to || span.to > steer.text.length) return undefined;
  const words = steer.text.slice(span.from, span.to).trim();
  return words || undefined;
}

/** A line placed among the others by its time, after every line at or before it. */
function placeByTime(lines: CrewLine[], line: CrewLine): void {
  const at = lines.findIndex((other) => other.at > line.at);
  if (at < 0) lines.push(line);
  else lines.splice(at, 0, line);
}

/** A call to one of the app's own tools that reads as a block, or null for an ordinary call. */
function blockLine(name: string, args: JsonRecord, id: string, at: number): CrewLine | null {
  if (name === CREW_BLOCK_TOOLS.plan) {
    const items = Array.isArray(args.plan)
      ? (args.plan as JsonRecord[]).flatMap((item) => {
          const state = planItemStateSchema.safeParse(item?.state);
          return typeof item?.label === "string" && state.success
            ? [{ label: redactObserveText(item.label), state: state.data }]
            : [];
        })
      : [];
    return { kind: "plan", id, at, text: redactObserveText(stringOf(args.text)), items };
  }
  if (name === CREW_BLOCK_TOOLS.report) {
    const text = bounded(redactObserveText(stringOf(args.text)));
    const summary = redactObserveText(firstLine(args.summary)) || firstLine(text);
    return { kind: "report", id, at, summary, text };
  }
  if (name === CREW_BLOCK_TOOLS.card) {
    return {
      kind: "card",
      id,
      at,
      title: redactObserveText(firstLine(args.title)),
      cardId: typeof args.id === "string" && args.id ? args.id : null,
    };
  }
  if (name === CREW_BLOCK_TOOLS.change) {
    return { kind: "change", id, at, title: redactObserveText(firstLine(args.title)) };
  }
  return null;
}

function callLine(
  name: string,
  args: JsonRecord,
  id: string,
  at: number,
  worktree: string,
): Extract<CrewLine, { kind: "tool" }> {
  const target = clip(redactObserveText(targetOf(name, args, worktree)));
  const described = firstLine(args.description);
  const reading = described
    ? clip(redactObserveText(described))
    : target
      ? ""
      : actionText({ at, name, arguments: args }, worktree);
  const diff = diffOf(name, args);
  return {
    kind: "tool",
    id,
    at,
    name,
    target,
    reading,
    result: null,
    ...(diff ? { diff } : {}),
  };
}

/** The one argument a call is about, in one line, a path in the working copy relative to it. */
function targetOf(name: string, args: JsonRecord, worktree: string): string {
  const path = (value: unknown): string => {
    const raw = firstLine(value);
    if (!raw || !worktree) return raw;
    if (raw === worktree) return ".";
    return raw.startsWith(`${worktree}/`) ? raw.slice(worktree.length + 1) : raw;
  };
  const file = path(args.file_path ?? args.path ?? args.notebook_path);
  const pattern = firstLine(args.pattern);
  switch (name.toLowerCase()) {
    case "bash": {
      // The app's own task command reads as what it was asked to do, never
      // what a crewmate typed into a page with it (docs/axi-commands.md).
      const command = firstLine(args.command);
      return runsTaskCommand(command) ? taskCommandShown(command) : command;
    }
    case "grep":
      return pattern ? `"${pattern}"${file ? ` in ${file}` : ""}` : file;
    case "glob":
    case "find":
      return pattern || file;
    case "webfetch":
    case "browser_navigate":
      return firstLine(args.url);
    case "websearch":
      return firstLine(args.query);
    case "browser_act":
      return [firstLine(args.action), firstLine(args.ref)].filter(Boolean).join(" ");
    case "browser_capture":
      return firstLine(args.name);
    case "github_read":
    case "github_write":
      return [firstLine(args.method), firstLine(args.path)].filter(Boolean).join(" ");
    case "tasks":
      return firstLine(args.key ?? args.text ?? args.project);
    case "knowledge":
      return firstLine(args.query ?? args.id);
    case "reply":
    case "close_card":
      return firstLine(args.card_id);
    case "file_followup":
    case "record_knowledge":
      return firstLine(args.title);
    default:
      return file;
  }
}

/** What a call's result answered: its line count, its first line, and its pictures by ref. */
function resultOf(message: JsonRecord, entryRef: string): CrewResult {
  const content = Array.isArray(message.content) ? (message.content as JsonRecord[]) : [];
  const text = textOf(content).replace(/\s+$/, "");
  const pictures: CrewPictureRef[] = [];
  content.forEach((part, index) => {
    if (part?.type === "image" && typeof part.data === "string" && part.data) {
      pictures.push({
        ref: `${entryRef}#${index}`,
        mimeType: typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "image/png",
      });
    }
  });
  return {
    ref: entryRef,
    lines: text ? text.split("\n").length : 0,
    preview: clip(redactObserveText(firstLine(text))),
    error: message.isError === true,
    pictures,
  };
}

/**
 * What an edit or a write changed, from the call's own arguments: each
 * replacement as the lines it took out and put in, with up to two lines of
 * what it kept on either side, and a whole new file as its lines. Redacted
 * before it is split, so a secret over several lines goes whole.
 */
export function diffOf(name: string, args: JsonRecord): CrewDiff | undefined {
  const pairs: { before: string; after: string }[] = [];
  const tool = name.toLowerCase();
  if (tool === "edit" || tool === "multiedit") {
    const edits = Array.isArray(args.edits) ? (args.edits as JsonRecord[]) : [args];
    for (const edit of edits) {
      const before = edit?.old_string ?? edit?.oldText;
      const after = edit?.new_string ?? edit?.newText;
      if (typeof before === "string" && typeof after === "string") pairs.push({ before, after });
    }
  } else if (tool === "write" && typeof args.content === "string") {
    pairs.push({ before: "", after: args.content });
  } else {
    return undefined;
  }
  if (pairs.length === 0) return undefined;
  const lines: CrewDiffLine[] = [];
  let added = 0;
  let removed = 0;
  pairs.forEach((pair, index) => {
    if (index > 0) lines.push({ kind: "gap", text: "" });
    const hunk = hunkOf(redactObserveText(pair.before), redactObserveText(pair.after));
    for (const line of hunk) {
      if (line.kind === "added") added += 1;
      if (line.kind === "removed") removed += 1;
      lines.push(line);
    }
  });
  return {
    added,
    removed,
    lines: lines.slice(0, CREW_DIFF_LINES_MAX),
    more: Math.max(0, lines.length - CREW_DIFF_LINES_MAX),
  };
}

/** How many unchanged lines a hunk keeps on either side of what changed. */
const CONTEXT_LINES = 2;

function hunkOf(before: string, after: string): CrewDiffLine[] {
  const old = before ? before.replace(/\n$/, "").split("\n") : [];
  const next = after ? after.replace(/\n$/, "").split("\n") : [];
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  const context = (text: string): CrewDiffLine => ({ kind: "context", text });
  return [
    ...old.slice(Math.max(0, head - CONTEXT_LINES), head).map(context),
    ...old.slice(head, old.length - tail).map((text): CrewDiffLine => ({ kind: "removed", text })),
    ...next.slice(head, next.length - tail).map((text): CrewDiffLine => ({ kind: "added", text })),
    ...old.slice(old.length - tail, old.length - tail + CONTEXT_LINES).map(context),
  ];
}

function startOf(entries: readonly JsonRecord[]): number | null {
  for (const entry of entries) {
    const at = timeOf(entry);
    if (at !== null) return at;
  }
  return null;
}

function entryIdOf(entry: JsonRecord, index: number): string {
  return typeof entry.id === "string" && entry.id ? entry.id : `@${index}`;
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
    .filter(Boolean)
    .join("\n");
}

function timeOf(entry: JsonRecord): number | null {
  const value = entry.timestamp ?? (entry.message as JsonRecord | undefined)?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const end = trimmed.indexOf("\n");
  return (end < 0 ? trimmed : trimmed.slice(0, end)).trim();
}

/** A call's target or reading in one line, ending in an ellipsis past its bound. */
function clip(text: string): string {
  return text.length > CREW_CALL_TEXT_MAX
    ? `${cutText(text, CREW_CALL_TEXT_MAX - 1).trimEnd()}…`
    : text;
}

function bounded(text: string): string {
  return text.length > CREW_TEXT_MAX ? `${cutText(text, CREW_TEXT_MAX - 1).trimEnd()}…` : text;
}
