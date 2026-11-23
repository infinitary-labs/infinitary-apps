import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { holderAlive, predatesBoot, processAlive } from "../helper/lock";

/**
 * The lock a one-time move of a data folder holds (a later step writes it).
 * It sits beside the data folder, never inside it: the move renames that
 * folder, and Electron's single-instance lock lives inside userData, so that
 * lock cannot guard the move. A lock whose process is gone is stale and does
 * not block, and so is one written before this computer last started, whose
 * process ended with that start whoever has its number now. Any other lock
 * that cannot be read is held, never guessed away, because the move writes
 * it whole or not at all.
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

export function moveLockPathFor(dataRoot: string): string {
  return join(dirname(dataRoot), `${basename(dataRoot)}${MOVE_LOCK_SUFFIX}`);
}

/**
 * True while a move holds the lock: the file is there, written since this
 * computer last started, and it is unreadable or names a live process.
 */
export function moveLockHeld(lockPath: string, alive: (pid: number) => boolean = processAlive) {
  let raw: string | undefined;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  const lock = raw === undefined ? undefined : parseMoveLock(raw);
  if (lock) return holderAlive(lockPath, lock.pid, alive);
  // Unreadable, and not from before this computer last started: still held.
  return !predatesBoot(lockPath);
}

/**
 * How long a move's lock is believed for a reader that only reports on it
 * (`moveLockRunning`). A move of a large folder takes minutes - the Mac
 * mini's 2.5 GB took about three - so half an hour covers a slow disk
 * several times over; a lock older than that belongs to a move that is stuck
 * or abandoned, and what waits on it should say so again rather than wait
 * on it for good.
 */
export const MOVE_LOCK_TRUST_MS = 30 * 60 * 1000;

/**
 * Whether a move is under way now, for a reader that only reports on it: the
 * lock is held (`moveLockHeld`) and began within `MOVE_LOCK_TRUST_MS`. A lock
 * that cannot be read counts from when its file was written, as an
 * unreadable lock is still held for the move itself.
 */
export function moveLockRunning(
  lockPath: string,
  now: () => number = Date.now,
  alive: (pid: number) => boolean = processAlive,
): boolean {
  // One read answers both whether it is held (as `moveLockHeld`) and when it began.
  let began = Number.NaN;
  let raw: string | undefined;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  const lock = raw === undefined ? undefined : parseMoveLock(raw);
  if (lock) {
    if (!holderAlive(lockPath, lock.pid, alive)) return false;
    began = Date.parse(lock.startedAt);
  } else if (predatesBoot(lockPath)) return false;
  // Unreadable: held, and counted from the file's own time.
  if (Number.isNaN(began)) {
    try {
      began = statSync(lockPath).mtimeMs;
    } catch {
      return false;
    }
  }
  return now() - began < MOVE_LOCK_TRUST_MS;
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

export function releaseMoveLock(lockPath: string, pid: number = process.pid): void {
  const lock = parseMoveLock(readFileOr(lockPath));
  if (lock?.pid === pid) unlinkSync(lockPath);
}
