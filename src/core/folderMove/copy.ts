import { spawn } from "node:child_process";
import { constants, lstatSync, type Stats, statfsSync } from "node:fs";
import { join } from "node:path";
import { hostEnv } from "../hostEnv";
import { atUtilityQos } from "../utilityQos";
import { chmod, cp, lstat, mkdir, readdir, rm, utimes } from "./plainFs";
import { COPIED_ONE_BY_ONE, COPIED_TWO_DEEP, leftBehind } from "./tree";

/**
 * The staged copy of a data folder (./move.ts): every top-level entry but
 * those left behind (`leftBehind`), one after another, so the move can say
 * how far it is. On a Mac the system's own `cp -c -p -R` clones each file
 * where the disk can (APFS), so the copy costs no room until a file in
 * either folder changes, and keeps permissions, times and links; Node
 * cannot clone there (scripts/clone-or-copy.ts). Where `cp` refuses - a socket inside the
 * entry, say - and on every other system, Node's own copy keeps links as
 * links, permissions and times, asks the disk for a reflink and skips
 * sockets and pipes.
 */

/** Units copied at once (`copyTree`). */
const UNITS_AT_ONCE = 4;

/** APFS's `f_type`, the one disk here a Mac's `cp -c` clones on. */
const APFS = 0x1a;

export type CopyOptions = {
  platform: NodeJS.Platform;
  /** The Mac's copier, by path: a GNU cp earlier on the search path reads `-c` as something else. */
  cp?: string;
};

/** Whether a copy into `dir` clones files rather than writing them again. */
export function copyClones(dir: string, platform: NodeJS.Platform): boolean {
  if (platform !== "darwin") return false;
  try {
    return statfsSync(dir).type === APFS;
  } catch {
    return false;
  }
}

/**
 * Whether the system's copier clones from `root` into `dir`: a clone needs
 * both on the one disk, and where it cannot clone the copier writes the
 * bytes again without saying so.
 */
export function clonesFrom(root: string, dir: string, platform: NodeJS.Platform): boolean {
  if (!copyClones(dir, platform)) return false;
  try {
    return statfsSync(root).type === APFS && lstatSync(root).dev === lstatSync(dir).dev;
  } catch {
    return false;
  }
}

/** The bytes free for this user on the disk that holds `dir`. */
export function freeBytes(dir: string): number {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

function systemCopy(cpPath: string, source: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command = atUtilityQos(cpPath, ["-c", "-p", "-R", source, target]);
    const child = spawn(command.file, command.args, { env: hostEnv(), stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function liveEndpoint(path: string): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch {
    return false;
  }
  return stats.isSocket() || stats.isFIFO() || stats.isBlockDevice() || stats.isCharacterDevice();
}

async function nodeCopy(source: string, target: string): Promise<void> {
  await cp(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    mode: constants.COPYFILE_FICLONE,
    filter: async (from) => !(await liveEndpoint(from)),
  });
}

async function isFolder(path: string): Promise<boolean> {
  return (await lstat(path)).isDirectory();
}

/**
 * The folders copied entry by entry, relative to `root`, outermost first:
 * those copied one by one (`COPIED_ONE_BY_ONE`), and inside those copied two
 * deep (`COPIED_TWO_DEEP`) each folder they hold.
 */
async function splitFolders(root: string): Promise<string[]> {
  const split: string[] = [];
  for (const name of [...COPIED_ONE_BY_ONE].sort()) {
    try {
      if (!(await isFolder(join(root, name)))) continue;
    } catch {
      continue;
    }
    split.push(name);
    if (!COPIED_TWO_DEEP.has(name)) continue;
    for (const child of (await readdir(join(root, name))).sort())
      if (!leftBehind([name, child]) && (await isFolder(join(root, name, child))))
        split.push(join(name, child));
  }
  return split;
}

/**
 * What the move copies from `root`, in the order it copies them, each as a
 * path relative to it: every top-level entry but those left behind, and the
 * entries of the folders copied entry by entry (`splitFolders`), but those
 * left behind, in place of those folders.
 */
export async function copyUnits(root: string): Promise<string[]> {
  const split = new Set(await splitFolders(root));
  const units: string[] = [];
  const add = async (parts: string[]) => {
    const path = join(...parts);
    if (leftBehind(parts) || (await liveEndpoint(join(root, path)))) return;
    if (!split.has(path)) {
      units.push(path);
      return;
    }
    for (const child of (await readdir(join(root, path))).sort()) await add([...parts, child]);
  };
  for (const name of (await readdir(root)).sort()) await add([name]);
  return units;
}

/**
 * Copies one entry of the data folder into the staged folder, answering
 * whether the system's copier made it (`clonesFrom` says whether that is a
 * clone). A failure throws with the system's own code (`ENOSPC` when the
 * disk is full).
 */
export async function copyEntry(
  source: string,
  target: string,
  options: CopyOptions,
): Promise<boolean> {
  if (options.platform === "darwin") {
    if (await systemCopy(options.cp ?? "/bin/cp", source, target)) return true;
    await rm(target, { recursive: true, force: true });
  }
  await nodeCopy(source, target);
  return false;
}

/**
 * Copies everything the move copies from `root` into `staged`, which exists
 * and is empty, saying each unit done (`copyUnits`) and whether the disk
 * cloned it: only a clone is the source's own bytes, and a unit the copier
 * wrote is checked by its bytes (`tree.ts` `compareTrees`). A folder copied
 * entry by entry takes its permissions once its entries are in.
 */
export async function copyTree(
  root: string,
  staged: string,
  options: CopyOptions & { done?: (unit: string, cloned: boolean) => void },
): Promise<void> {
  const split = await splitFolders(root);
  for (const path of split) await mkdir(join(staged, path), { mode: 0o700 });
  const clones = clonesFrom(root, staged, options.platform);
  // Several units at once: a clone or copy of many small files waits on the
  // disk one file at a time, so units side by side keep it busy.
  // A failure stops the others taking another unit, and is thrown once every
  // copy under way has ended, so nothing still writes into the staged folder.
  const units = await copyUnits(root);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < units.length) {
      const unit = units[next++] as string;
      try {
        const system = await copyEntry(join(root, unit), join(staged, unit), options);
        options.done?.(unit, clones && system);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const ended = await Promise.allSettled(Array.from({ length: UNITS_AT_ONCE }, worker));
  const failure = ended.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  for (const path of split.reverse()) {
    const stats = await lstat(join(root, path));
    await chmod(join(staged, path), stats.mode & 0o7777);
    await utimes(join(staged, path), stats.atime, stats.mtime);
  }
}
