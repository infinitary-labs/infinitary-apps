import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { TaskActionLine } from "@shared/tasks";
import { runsTaskCommand } from "../axi/names";
import { redactObserveText } from "../observe/redact";
import {
  type SessionDialect,
  type SessionToolCall,
  sessionDialectAt,
  sessionFilesIn,
  sessionToolCalls,
} from "../storage/sessionReader";
import type { TaskRecord } from "../storage/taskStore";

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
  /** The time of the newest call read, for a call whose line names none. */
  lastAt: number;
  actions: TaskActionLine[];
};

/**
 * A crewmate's actions, read from the sessions the app keeps for its task
 * at each read, never copied into the task table (FI3-1189's rule 3). Each
 * is a call it made to a tool other than the app's own, in the line it
 * wrote to say what the call does, or a plain reading of the call when it
 * wrote none. A session is followed as it grows: each read parses only the
 * whole lines appended since the last, so a long session costs one scan.
 */
export class CrewActions {
  private readonly followed = new Map<string, Followed>();

  constructor(private readonly options: CrewActionsOptions) {}

  /** Every action the task's crewmate took, oldest first. */
  of(task: TaskRecord): TaskActionLine[] {
    const actions = this.files(task).flatMap((file) => this.read(file, task.worktreeDir));
    return actions.sort((a, b) => a.at - b.at);
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
    try {
      size = statSync(path).size;
    } catch {
      return [];
    }
    let held = this.followed.get(path);
    // A file shorter than what was read, or a task now in another working
    // copy, is read again from the start.
    if (held && (size < held.offset || held.worktree !== worktree)) held = undefined;
    if (!held) {
      const dialect = sessionDialectAt(path);
      if (!dialect) return [];
      held = { dialect, worktree, offset: 0, lastAt: 0, actions: [] };
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
        for (const call of sessionToolCalls(text, held.dialect)) {
          if (this.options.appTools.has(call.name) || isAppCommand(call)) continue;
          const at = call.at ?? held.lastAt;
          held.lastAt = Math.max(held.lastAt, at);
          held.actions.push({ at, text: actionText(call, worktree) });
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
  const text = described || readingOf(call, worktree);
  const redacted = redactObserveText(text);
  return redacted.length > ACTION_TEXT_MAX
    ? `${redacted.slice(0, ACTION_TEXT_MAX - 1).trimEnd()}…`
    : redacted;
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
