/**
 * The dispatch extractor's session files (`scripts/extract-dispatch-corpus.ts`):
 * which transcripts to read, and which of them are only a second copy of a
 * session already read.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readSession, sessionFilesIn } from "../../src/core/storage/sessionReader.ts";
import { timestampOf } from "./dispatchTurns.ts";
import { readFirstmateSessionFile } from "./userData.ts";

type JsonRecord = Record<string, unknown>;

/** Where the transcripts are: explicit files, or the directories that hold them. */
export type SessionSources = {
  /** Explicit transcript files, of either dialect; override the directories when non-empty. */
  sessionFiles?: string[];
  sessionsDir?: string;
  /** The Claude-served sessions' copies (`firstmate/claude/`, W1 S11). */
  claudeSessionsDir?: string;
};

/**
 * One session's file on disk: its header identity, and how much of it there
 * is. Two files carrying the SAME session id are the same session twice - a
 * copy of the sessions directory, a restored backup, a sync conflict - and
 * only the most complete of them is evidence.
 */
export type SessionFile = {
  path: string;
  raw: string;
  sessionId: string | null;
  at: number;
  entries: number;
};

export function readSessionFile(path: string): SessionFile {
  // The one reader: a Claude-served session arrives in the Pi dialect.
  const raw = readSession(path).text;
  let sessionId: string | null = null;
  let at = 0;
  let entries = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(trimmed) as JsonRecord;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      at = timestampOf(entry) ?? at;
      continue;
    }
    entries += 1;
  }
  return { path, raw, sessionId, at, entries };
}

/**
 * The backup split: for every session id, the most complete file is the one
 * that is read, and every other copy of it is reported as a backup. A file
 * with no readable session header is never grouped - it can only stand for
 * itself. Ties break on the path so a second run picks the same file.
 */
export function splitBackupCopies(files: SessionFile[]): {
  kept: SessionFile[];
  backups: SessionFile[];
} {
  const groups = new Map<string, SessionFile[]>();
  for (const file of files) {
    const key = file.sessionId ? `id:${file.sessionId}` : `path:${file.path}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(file);
    groups.set(key, bucket);
  }
  const kept: SessionFile[] = [];
  const backups: SessionFile[] = [];
  for (const bucket of groups.values()) {
    const ranked = [...bucket].sort(
      (a, b) => b.entries - a.entries || b.raw.length - a.raw.length || a.path.localeCompare(b.path),
    );
    const [first, ...rest] = ranked;
    if (first) kept.push(first);
    backups.push(...rest);
  }
  kept.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  backups.sort((a, b) => a.path.localeCompare(b.path));
  return { kept, backups };
}

export function resolveSessionFiles(options: SessionSources, dbPath: string | null): string[] {
  const explicit = (options.sessionFiles ?? []).filter((file) => existsSync(file));
  if (explicit.length > 0) return explicit.map((file) => resolve(file));
  const found = new Set<string>();
  for (const dir of [options.sessionsDir, options.claudeSessionsDir]) {
    if (!dir) continue;
    for (const file of sessionFilesIn(dir)) found.add(resolve(file));
  }
  // The settings row names the rolling session even when it sits elsewhere.
  if (dbPath) {
    const recorded = readFirstmateSessionFile(dbPath);
    if (recorded && existsSync(recorded)) found.add(resolve(recorded));
  }
  return [...found].sort();
}
