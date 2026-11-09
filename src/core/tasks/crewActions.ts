import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { TaskActionLine } from "@shared/tasks";
import { runsTaskCommand } from "../axi/names";
import { redactObserveText } from "../observe/redact";
import {
  type SessionDialect,
  type SessionToolCall,
  sessionAssistantLines,
  sessionDialectAt,
  sessionFilesIn,
} from "../storage/sessionReader";
import type { TaskRecord } from "../storage/taskRecords";

export type CrewActionsOptions = {
  /** Where the app keeps a task's sessions (`crewmates/<task>/sessions/`). */
  recordDirOf: (taskId: string) => string;
  /**
   * The file holding the session the crewmate runs now, when it is not the
   * copy in its record dir: a Claude client's own file while it holds a
   * turn's tail the copy has not caught up with yet.
   */
  currentSession?: (task: TaskRecord) => string | null;
  /** The app's own tools: their calls are already the task's events. */
  appTools: ReadonlySet<string>;
};

/** An action and where it was read: its session file's name and its place among that file's actions. */
export type SourcedAction = TaskActionLine & { file: string; index: number };

/** The longest an action's line reads; a longer one ends in an ellipsis. */
export const ACTION_TEXT_MAX = 160;

/** How many session files the reader follows at once, the least recently read let go first. */
const FOLLOWED_MAX = 64;

/** A session file as far as it was read. */
type Followed = {
  dialect: SessionDialect;
  worktree: string;
  /** The byte just past the last whole line read. */
  offset: number;
  /** The file read, by its inode. */
  ino: number;
  /** The time of the newest call read, for a call whose line names none. */
  lastAt: number;
  actions: TaskActionLine[];
  /** The newest sentence the crewmate wrote in it, when it wrote one. */
  said: TaskActionLine | null;
};

/**
 * A crewmate's actions, read from the sessions the app keeps for its task
 * at each read, never copied into the task table (FI3-1189's rule 3). Each
 * is a call it made to a tool other than the app's own, in the line it
 * wrote to say what the call does, or a plain reading of the call when it
 * wrote none. A session is followed as it grows: each read parses only the
 * whole lines appended since the last, so a long session costs one scan.
 * The newest sentence it wrote is read on the same pass, for its Now line.
 */
export class CrewActions {
  private readonly followed = new Map<string, Followed>();

  constructor(private readonly options: CrewActionsOptions) {}

  /** Every action the task's crewmate took, oldest first. */
  of(task: TaskRecord): TaskActionLine[] {
    const actions = this.files(task).flatMap((file) => this.read(file, task.worktreeDir));
    return actions.sort((a, b) => a.at - b.at);
  }

  /**
   * Every action with where it was read, file by file (the unified
   * timeline's source identity, `TaskTimeline`): the kept session's file
   * name and the action's place among that file's actions. A session only
   * grows, so a place names the same action at every read.
   */
  sourced(task: TaskRecord): SourcedAction[] {
    return this.files(task).flatMap((file) =>
      this.read(file, task.worktreeDir).map((action, index) => ({
        ...action,
        file: basename(file),
        index,
      })),
    );
  }

  /**
   * The last sentence the task's crewmate wrote, with its time (INF-557):
   * its Now line between its notes. Null when it wrote none.
   */
  said(task: TaskRecord): TaskActionLine | null {
    let newest: TaskActionLine | null = null;
    for (const file of this.files(task)) {
      this.read(file, task.worktreeDir);
      const said = this.followed.get(file)?.said ?? null;
      if (said && (!newest || said.at >= newest.at)) newest = said;
    }
    return newest;
  }

  private files(task: TaskRecord): string[] {
    const files = sessionFilesIn(this.options.recordDirOf(task.id));
    const current = this.options.currentSession?.(task) ?? null;
    if (!current || files.includes(current)) return files;
    // The same session, further along: it stands in for the copy of it.
    return [...files.filter((file) => basename(file) !== basename(current)), current];
  }

  private read(path: string, worktree: string): TaskActionLine[] {
    let size: number;
    let ino: number;
    try {
      ({ size, ino } = statSync(path));
    } catch {
      return [];
    }
    let held = this.followed.get(path);
    // A file shorter than what was read, one written again whole
    // (`SavedOutsideData`), or a task now in another working copy, is read
    // again from the start.
    if (held && (size < held.offset || held.ino !== ino || held.worktree !== worktree)) {
      held = undefined;
    }
    if (!held) {
      const dialect = sessionDialectAt(path);
      if (!dialect) return [];
      held = { dialect, worktree, offset: 0, ino, lastAt: 0, actions: [], said: null };
    }
    this.followed.delete(path);
    this.followed.set(path, held);
    if (this.followed.size > FOLLOWED_MAX) {
      const oldest = this.followed.keys().next().value;
      if (oldest !== undefined) this.followed.delete(oldest);
    }
    if (size > held.offset) {
      const { text, bytes } = appendedLines(path, held.offset, size);
      if (bytes > 0) {
        held.offset += bytes;
        for (const line of sessionAssistantLines(text, held.dialect)) {
          const at = line.at ?? held.lastAt;
          held.lastAt = Math.max(held.lastAt, at);
          const sentence = lastSentence(line.texts);
          if (sentence) held.said = { at, text: sentence };
          for (const call of line.calls) {
            if (this.options.appTools.has(call.name) || isAppCommand(call)) continue;
            held.actions.push({ at, text: actionText(call, worktree) });
          }
        }
      }
    }
    return held.actions;
  }
}

/** A shell call that runs one of the app's own task commands, such as `infinitary-browser-axi`. */
function isAppCommand(call: SessionToolCall): boolean {
  const command = call.arguments.command;
  return (
    call.name.toLowerCase() === "bash" && typeof command === "string" && runsTaskCommand(command)
  );
}

/** The whole lines between `from` and `to`; a torn last line waits for the next read. */
function appendedLines(path: string, from: number, to: number): { text: string; bytes: number } {
  const none = { text: "", bytes: 0 };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return none;
  }
  try {
    const buffer = Buffer.alloc(to - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    return end < 0 ? none : { text: buffer.toString("utf8", 0, end + 1), bytes: end + 1 };
  } catch {
    return none;
  } finally {
    closeSync(fd);
  }
}

/**
 * An action in one line: the description the crewmate wrote for the call,
 * or, when it wrote none, a plain reading of the call from its typed
 * arguments, with a path inside the task's working copy relative to it.
 * Redacted as a crewmate's update is.
 */
export function actionText(call: SessionToolCall, worktree: string): string {
  const described = firstLine(call.arguments.description);
  return oneLine(described || readingOf(call, worktree));
}

/** Redacted as a crewmate's update is, and cut to `ACTION_TEXT_MAX`. */
function oneLine(text: string): string {
  const redacted = redactObserveText(text);
  return redacted.length > ACTION_TEXT_MAX
    ? `${redacted.slice(0, ACTION_TEXT_MAX - 1).trimEnd()}…`
    : redacted;
}

/**
 * The last sentence of the words an assistant line wrote: of its last line
 * with words, past a list's or a heading's mark. Empty when it wrote none.
 */
export function lastSentence(texts: readonly string[]): string {
  const lines = texts
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```") && !/^[-*_|=\s]+$/.test(line));
  const last = lines.at(-1)?.replace(/^(?:#+|>|[-*+]|\d+[.)])\s+/, "") ?? "";
  const sentences = last.split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);
  const sentence = sentences.at(-1)?.trim() ?? "";
  return sentence ? oneLine(sentence) : "";
}

function readingOf(call: SessionToolCall, worktree: string): string {
  const args = call.arguments;
  const path = (value: unknown): string => {
    const raw = firstLine(value);
    if (!raw || !worktree) return raw;
    if (raw === worktree) return "the working copy";
    return raw.startsWith(`${worktree}/`) ? raw.slice(worktree.length + 1) : raw;
  };
  const file = path(args.file_path ?? args.path ?? args.notebook_path);
  const pattern = firstLine(args.pattern);
  switch (call.name.toLowerCase()) {
    case "bash": {
      const command = firstLine(args.command);
      return command ? `Ran ${command}` : "Ran a command";
    }
    case "read":
      return file ? `Read ${file}` : "Read a file";
    case "edit":
    case "multiedit":
    case "notebookedit":
      return file ? `Edited ${file}` : "Edited a file";
    case "write":
      return file ? `Wrote ${file}` : "Wrote a file";
    case "grep":
      return pattern ? `Searched for "${pattern}"${file ? ` in ${file}` : ""}` : "Searched";
    case "find":
    case "glob":
      return pattern ? `Looked for files matching ${pattern}` : "Looked for files";
    case "ls":
      return `Listed ${file || "the working copy"}`;
    case "webfetch": {
      const url = firstLine(args.url);
      return url ? `Read ${url}` : "Read a web page";
    }
    case "websearch": {
      const query = firstLine(args.query);
      return query ? `Searched the web for "${query}"` : "Searched the web";
    }
    default:
      return `Used ${call.name}`;
  }
}

function firstLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const end = trimmed.indexOf("\n");
  return (end < 0 ? trimmed : trimmed.slice(0, end)).trim();
}
