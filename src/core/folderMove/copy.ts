import { spawn } from "node:child_process";
import { constants, type Stats, statfsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { hostEnv } from "../hostEnv";
import { atUtilityQos } from "../utilityQos";
import { COPIED_ONE_BY_ONE, leftBehind } from "./tree";

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

/**
 * What the move copies from `root`, in the order it copies them, each as a
 * path relative to it: every top-level entry but those left behind, and the
 * entries of the folders copied one by one, but those left behind, in place
 * of those folders.
 */
export async function copyUnits(root: string): Promise<string[]> {
  const units: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (leftBehind([name]) || (await liveEndpoint(join(root, name)))) continue;
    const stats = await lstat(join(root, name));
    if (COPIED_ONE_BY_ONE.has(name) && stats.isDirectory()) {
      for (const child of (await readdir(join(root, name))).sort())
        if (!leftBehind([name, child]) && !(await liveEndpoint(join(root, name, child))))
          units.push(join(name, child));
    } else {
      units.push(name);
    }
  }
  return units;
}

/**
 * Copies one entry of the data folder into the staged folder. A failure
 * throws with the system's own code (`ENOSPC` when the disk is full).
 */
export async function copyEntry(
  source: string,
  target: string,
  options: CopyOptions,
): Promise<void> {
  if (options.platform === "darwin") {
    if (await systemCopy(options.cp ?? "/bin/cp", source, target)) return;
    await rm(target, { recursive: true, force: true });
  }
  await nodeCopy(source, target);
}

/**
 * Copies everything the move copies from `root` into `staged`, which exists
 * and is empty, saying each unit done (`copyUnits`). A folder copied one by
 * one takes its permissions once its entries are in.
 */
export async function copyTree(
  root: string,
  staged: string,
  options: CopyOptions & { done?: (unit: string) => void },
): Promise<void> {
  const split = new Set<string>();
  for (const name of [...COPIED_ONE_BY_ONE].sort()) {
    let stats: Stats;
    try {
      stats = await lstat(join(root, name));
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    await mkdir(join(staged, name), { mode: 0o700 });
    split.add(name);
  }
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
        await copyEntry(join(root, unit), join(staged, unit), options);
        options.done?.(unit);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const ended = await Promise.allSettled(Array.from({ length: UNITS_AT_ONCE }, worker));
  const failure = ended.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  for (const name of split) {
    const stats = await lstat(join(root, name));
    await chmod(join(staged, name), stats.mode & 0o7777);
    await utimes(join(staged, name), stats.atime, stats.mtime);
  }
}
