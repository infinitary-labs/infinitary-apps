import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { BackendId } from "@shared/providers";
import { locateClaudeTranscript } from "../claude/claudeTranscript";
import { sessionDialectAt } from "../storage/sessionReader";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import type { TaskRecord } from "../storage/taskStore";

/**
 * Which file, if any, holds a crewmate's transcript. `tasks.session_file`
 * is the backend's opaque resume token: a Pi JSONL path for Pi crewmates,
 * but a session id for Claude - which is why treating it as a path
 * rendered every Claude crewmate as a blank pane. A Claude crewmate's
 * transcript is read from the app's own copy, beside a Pi crewmate's file
 * in its task's record dir, which outlives the client's 30-day sweep; from
 * the client's own file before the first copy lands, and while it holds a
 * turn's tail the copy has not caught up with yet.
 */
export type CrewmateTranscriptSource = {
  /** The backend that ran the task; null when its account is gone. */
  backend: BackendId | null;
  /** A file the matching parser can read, or null when none exists (yet). */
  path: string | null;
};

export type CrewmateTranscriptResolver = (task: TaskRecord) => CrewmateTranscriptSource;

/** The default when no broker is wired: every session file is Pi's. */
export const piOnlyTranscriptResolver: CrewmateTranscriptResolver = (task) => ({
  backend: "pi",
  path: task.sessionFile,
});

export function createCrewmateTranscriptResolver(deps: {
  backendOf: (accountId: string) => BackendId | undefined;
  /** The account's own config dir when its backend keeps one. */
  configDirOf: (accountId: string) => string | undefined;
  /** Where the app keeps a task's session records (`crewmates/<task>/sessions/`). */
  recordDirOf: (taskId: string) => string;
}): CrewmateTranscriptResolver {
  // A located Claude transcript never moves, so the list poll pays the
  // directory walk once per task, then one stat.
  const located = new Map<string, string>();
  return (task) => {
    // A crewmate on another computer: its token names that computer's file,
    // so this Mac reads the copy it keeps of the record, by the same name.
    if (task.deviceId) {
      const path = placedCopyOf(deps.recordDirOf(task.id), task.sessionFile);
      // Its account belongs to that computer, not this Mac's broker. Read
      // the copied record's dialect, just as the task's Activity does.
      const backend = path ? (sessionDialectAt(path) ?? "pi") : "pi";
      return { backend, path };
    }
    if (!task.accountId) return piOnlyTranscriptResolver(task);
    const backend = deps.backendOf(task.accountId);
    if (!backend) return { backend: null, path: null };
    if (backend === "pi") return { backend, path: task.sessionFile };
    if (backend !== "claude" || !task.sessionFile) return { backend, path: null };
    const copy = appCopyOf(deps.recordDirOf(task.id), task.sessionFile);
    const client = clientFileOf(task, task.accountId, task.sessionFile);
    // The copy is the client's file up to the session's last copy, so the
    // client's holds more only while a turn's tail waits for the next one.
    if (copy && client) return { backend, path: sizeOf(client) > sizeOf(copy) ? client : copy };
    return { backend, path: copy ?? client };
  };

  function clientFileOf(task: TaskRecord, accountId: string, sessionId: string): string | null {
    const cached = located.get(task.id);
    if (cached) {
      if (existsSync(cached)) return cached;
      located.delete(task.id);
    }
    const configDir = deps.configDirOf(accountId);
    if (!configDir) return null;
    const path = locateClaudeTranscript({ configDir, cwd: task.worktreeDir, sessionId });
    if (path) located.set(task.id, path);
    return path;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** This Mac's copy of a record a computer that runs work holds, once it has one. */
function placedCopyOf(dir: string, token: string | null): string | null {
  if (!token) return null;
  // A Pi token is that computer's file; a Claude token is the session id its copy is named by.
  const path = token.endsWith(".jsonl") ? join(dir, basename(token)) : appCopyOf(dir, token);
  return path && existsSync(path) ? path : null;
}

/** The app's copy of a Claude session's transcript in a record dir, once it holds one. */
function appCopyOf(dir: string, sessionId: string): string | null {
  const store = new SessionRecordStore(dir);
  try {
    return store.has(sessionId) ? store.transcriptPath(sessionId) : null;
  } catch {
    // Not a session id the app would have copied under.
    return null;
  }
}
