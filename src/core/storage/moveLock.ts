import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/**
 * The lock a one-time move of a data folder holds (a later step writes it).
 * It sits beside the data folder, never inside it: the move renames that
 * folder, and Electron's single-instance lock lives inside userData, so that
 * lock cannot guard the move. A lock whose process is gone is stale and does
 * not block; a lock that cannot be read is held, never guessed away, because
 * the move writes it whole or not at all.
 */
export const MOVE_LOCK_SUFFIX = ".move-lock";

export const moveLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).max(64),
});
export type MoveLock = z.infer<typeof moveLockSchema>;

export const MOVE_LOCK_TITLE = "Infinitary is moving your saved work";
export const MOVE_LOCK_MESSAGE =
  "Open Infinitary again when the move finishes. Nothing here has been changed.";

/** The lock path for a data folder: its sibling, `<folder>.move-lock`. */
export function moveLockPathFor(dataRoot: string): string {
  return join(dirname(dataRoot), `${basename(dataRoot)}${MOVE_LOCK_SUFFIX}`);
}

/** Whether a process with this id exists; a process we may not signal still exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while a move holds the lock: the file is there, and it is unreadable or names a live process. */
export function moveLockHeld(lockPath: string, alive: (pid: number) => boolean = processAlive) {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const lock = parseMoveLock(raw);
  return lock === undefined || alive(lock.pid);
}

function parseMoveLock(raw: string): MoveLock | undefined {
  try {
    const parsed = moveLockSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock for this process, or returns false when a live move holds
 * it. A stale lock is replaced. The file is made with `wx`, so two movers
 * cannot both take it.
 */
export function acquireMoveLock(
  lockPath: string,
  pid: number = process.pid,
  now: () => Date = () => new Date(),
): boolean {
  const body = `${JSON.stringify({ schemaVersion: 1, pid, startedAt: now().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (moveLockHeld(lockPath)) return false;
      unlinkSync(lockPath);
    }
  }
  return false;
}

function readFileOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Releases the lock this process holds; a lock another process holds is left alone. */
export function releaseMoveLock(lockPath: string, pid: number = process.pid): void {
  const lock = parseMoveLock(readFileOr(lockPath));
  if (lock?.pid === pid) unlinkSync(lockPath);
}
