import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

/**
 * One process at a time works from a data folder (docs/helper.md): the one
 * that holds `running.lock`, which names its process. A lock whose process
 * is gone, or that was written before this computer last started, is taken over. The folder is made 0700 and the file 0600.
 */

const LOCK_FILE = "running.lock";

/** The folders this process holds now, so it cannot take one twice. */
const heldHere = new Set<string>();

/** Another process holds the folder. */
export class FolderBusyError extends Error {
  constructor(readonly pid: number) {
    super(`Process ${pid} already works from this folder.`);
    this.name = "FolderBusyError";
  }
}

/** Whether a process with this number is running now. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Running as someone else still means running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderIn(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Whether a lock was written before this computer last started. Its
 * process died with that start, and its number may belong to anything now,
 * including a process of another user that `processAlive` counts as running.
 * It reads the lock's own time, never a link's target, so Chromium's
 * `SingletonLock`, a link to nothing, reads too. The move lock and the move's
 * check that the older app is open read it too (`storage/moveLock.ts`,
 * `folderMove/move.ts` `chromiumHolds`).
 */
export function predatesBoot(path: string): boolean {
  try {
    return lstatSync(path).mtimeMs < Date.now() - uptime() * 1000 - 2000;
  } catch {
    return false;
  }
}

/** The process that holds the folder now, or null when none does. */
export function folderHolder(dir: string, alive = processAlive): number | null {
  const path = join(dir, LOCK_FILE);
  const pid = holderIn(path);
  return pid !== null && !predatesBoot(path) && alive(pid) ? pid : null;
}

/**
 * Takes the folder for this process, making it if it is missing, and answers
 * the release. Throws `FolderBusyError` while another live process holds it.
 */
export function lockFolder(
  dir: string,
  options: { pid?: number; alive?: (pid: number) => boolean } = {},
): () => void {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processAlive;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = holderIn(path);
      if (holder === pid && heldHere.has(path)) throw new FolderBusyError(pid);
      if (holder !== null && holder !== pid && !predatesBoot(path) && alive(holder))
        throw new FolderBusyError(holder);
      // Left by a process that is gone, or by an earlier one that had this
      // process's number: take it over.
      rmSync(path, { force: true });
      continue;
    }
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    heldHere.add(path);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      heldHere.delete(path);
      if (holderIn(path) === pid) rmSync(path, { force: true });
    };
  }
  throw new FolderBusyError(holderIn(path) ?? 0);
}

/** How long a command waits for a run it stopped to let the folder go. */
export const STOPPED_RUN_WAIT_MS = 15_000;

/**
 * Takes the folder once the process holding it lets it go, trying until
 * `waitMs` has passed; null while it is still held then. What a command
 * does after it stopped the background's run (`pauseInBackground`).
 */
export async function takeFolderWithin(dir: string, waitMs: number): Promise<(() => void) | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return lockFolder(dir);
    } catch (error) {
      if (!(error instanceof FolderBusyError)) throw error;
      if (Date.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
