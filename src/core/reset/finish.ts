import { readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { removeAll } from "../removeWhole";
import { acquireMoveLock, releaseMoveLock } from "../storage/moveLock";
import {
  RESETTING_SUFFIX,
  type ResetMark,
  type ResetOutsideKind,
  readResetMark,
  removeResetMark,
  resetLockPath,
  writeResetMark,
} from "./mark";

/**
 * Finishing a reset at the start after it (docs/reset.md, "At the next
 * start"): before anything reads or holds the data folder, the folder is
 * renamed aside in one step, the renamed folder and the older copies beside
 * it are deleted, the outside kinds the mark lists are cleared once, and the
 * mark goes last. Every step can run twice, so a start cut off at any of them
 * carries on at the next.
 */

/** Starts that may leave a renamed-aside folder before the mark goes anyway. */
export const ASIDE_TRIES = 3;

export type ResetFinishSeams = {
  /** Renames the folder; a Windows folder another program holds throws EBUSY or EPERM. */
  rename(from: string, to: string): void;
  /** Deletes a folder or file whole; true once it is gone. */
  remove(path: string): boolean;
  /**
   * Clears one outside kind; true once nothing of it is left. An isolated
   * run passes none, so it never reaches outside its own folder.
   */
  clearOutside?: (kind: ResetOutsideKind) => Promise<boolean>;
  /** The older copies beside the folder: retired folders, set-aside and half-made moves, the hand-over profile. */
  olderCopies: () => string[];
  /** Waits before the next try of a rename another program refuses. */
  wait(ms: number): Promise<void>;
};

export type ResetFinish =
  /** No reset was asked. */
  | { kind: "none" }
  /** The reset is finished: the folder is gone and the mark with it. */
  | { kind: "done"; left: ResetOutsideKind[] }
  /** Another start is finishing it now. */
  | { kind: "busy" }
  /** Another program holds the folder, so it could not be renamed aside. */
  | { kind: "held" };

/** How long a refused rename is tried again: a program that ends lets it go. */
const HELD_TRIES = 30;
const HELD_WAIT_MS = 2_000;

export const RESET_FINISH_SEAMS: Omit<ResetFinishSeams, "olderCopies"> = {
  rename: renameSync,
  remove: removeAll,
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
};

export async function finishReset(
  dataDir: string,
  seams: ResetFinishSeams,
  options: { pid?: number; heldTries?: number } = {},
): Promise<ResetFinish> {
  let mark = readResetMark(dataDir);
  if (!mark) return { kind: "none" };
  const pid = options.pid ?? process.pid;
  const lock = resetLockPath(dataDir);
  if (!acquireMoveLock(lock, pid)) return { kind: "busy" };
  try {
    if (mark.stage === "asked") {
      if (!(await renameAside(dataDir, pid, seams, options.heldTries ?? HELD_TRIES)))
        return { kind: "held" };
      mark = advance(dataDir, mark, { stage: "moved" });
    }
    if (mark.stage === "moved") {
      const kept = renamedAside(dataDir).filter((path) => !seams.remove(path));
      for (const path of seams.olderCopies()) seams.remove(path);
      const asideTries = (mark.asideTries ?? 0) + 1;
      mark = advance(
        dataDir,
        mark,
        kept.length > 0 && asideTries < ASIDE_TRIES ? { asideTries } : { stage: "outside" },
      );
    }
    // The outside kinds are cleared once, at the start that wipes the folder:
    // a later start may already run the fresh install, whose own Secrets,
    // start entries and preferences a retry would delete.
    const left: ResetOutsideKind[] = [];
    for (const kind of mark.outside) {
      const cleared = seams.clearOutside ? await seams.clearOutside(kind).catch(() => false) : true;
      if (!cleared) left.push(kind);
    }
    // A mark still at `moved` stays for the folder it could not delete; only
    // the renamed-aside folders are tried again, never the fresh one.
    if (mark.stage === "moved") {
      if (mark.outside.length > 0) advance(dataDir, mark, { outside: [] });
      return { kind: "done", left };
    }
    removeResetMark(dataDir);
    return { kind: "done", left };
  } finally {
    releaseMoveLock(lock, pid);
  }
}

function advance(dataDir: string, mark: ResetMark, change: Partial<ResetMark>): ResetMark {
  const next = { ...mark, ...change };
  writeResetMark(dataDir, next);
  return next;
}

/**
 * Renames the folder aside, or finds it already gone. A folder another
 * program holds refuses on Windows; it is tried again while that program may
 * still end, and the folder is never opened meanwhile.
 */
async function renameAside(
  dataDir: string,
  pid: number,
  seams: ResetFinishSeams,
  tries: number,
): Promise<boolean> {
  const aside = `${dataDir}${RESETTING_SUFFIX}${pid}`;
  for (let attempt = 0; ; attempt++) {
    try {
      seams.rename(dataDir, aside);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if ((code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") || attempt + 1 >= tries)
        return false;
      await seams.wait(HELD_WAIT_MS);
    }
  }
}

/** Every folder an earlier finishing start renamed aside and did not delete, its own included. */
function renamedAside(dataDir: string): string[] {
  const parent = dirname(dataDir);
  const prefix = `${basename(dataDir)}${RESETTING_SUFFIX}`;
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}
