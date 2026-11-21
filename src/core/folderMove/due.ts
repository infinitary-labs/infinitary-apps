import { randomUUID } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Spelling } from "@shared/codeNames";
import { type BuildFlavor, olderUserDataFolders, userDataFolderOf } from "@shared/userDataFolders";
import { isProfileRetired, RETIRED_PROFILE_MARKER } from "../storage/retiredProfile";
import { MOVE_RECORD, readMoveRecord } from "./record";
import { LEFT_BEHIND } from "./tree";

/**
 * Whether the one-time move is due (./move.ts), read cheaply and
 * synchronously before anything opens a folder: the window asks before
 * Electron reads its folder, and the work mode before it opens its work
 * (docs/helper.md, "Under the other name"). Nothing here loads the move
 * itself.
 */

/** A move from an older folder into this app's own. */
export type FolderMove = { from: string; to: string };

/**
 * The folder one attempt at a move builds before it renames it into place:
 * beside the app's own, named for the process making it. Each attempt has
 * its own, because a Mac's copier outlives an app that was stopped hard and
 * keeps writing where it was told: a later attempt never builds in a folder
 * an earlier one may still be filling.
 */
export function stagedFolderFor(to: string, pid: number = process.pid): string {
  return `${to}.moving-${pid}`;
}

/**
 * The name beside a data folder that reserves the folder holding the throwaway
 * profiles of the copies a launch refused the folder's lock starts to show the
 * person a word, a folder beside it named for it (src/main/personWord.ts,
 * docs/run.md): outside the data folder and every folder a move stages, sets
 * aside or brings, so a copy still using one keeps its path through any move,
 * and none of it is ever taken for saved work.
 */
export function wordProfilesBeside(dataDir: string): string {
  return `${dataDir}-word-profiles`;
}

/**
 * The profiles' folder's mark: a file this app writes whole in the folder it made, saying
 * `wordProfilesMark` of that folder's own name and nothing else, once that folder is this account's
 * alone; only then is the same file linked at the reserved name (`wordProfilesBeside`), which
 * reserves it. Anything else at that name is someone else's, never changed, read into or used.
 */
export const WORD_PROFILES_RESERVED = ".infinitary-word-profiles";
/**
 * What the profiles' folder's mark says, whole: which folder it marks, the one named `<reserved
 * name>.<id>` beside the reserved name, and which folder that was when the mark was written - its
 * device, number and birth, read whole - so the reservation names that one folder and no copy of
 * it, nor a folder put back at its name since.
 */
export const wordProfilesMark = (
  id: string,
  folder: { dev: bigint; ino: bigint; birthtimeNs: bigint },
) => `infinitary-word-profiles:2 ${id} ${folder.dev} ${folder.ino} ${folder.birthtimeNs}\n`;
/** The folder a mark's whole text names (`wordProfilesMark`), or null for any other text. */
export function wordProfilesMarked(
  text: string,
): { id: string; dev: bigint; ino: bigint; birthtimeNs: bigint } | null {
  const said =
    /^infinitary-word-profiles:2 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) (0|[1-9][0-9]{0,19}) (0|[1-9][0-9]{0,19}) (0|[1-9][0-9]{0,29})\n$/.exec(
      text,
    );
  if (!said) return null;
  return {
    id: said[1] as string,
    dev: BigInt(said[2] as string),
    ino: BigInt(said[3] as string),
    birthtimeNs: BigInt(said[4] as string),
  };
}
/** The longest whole mark. */
export const WORD_PROFILES_MARK_BYTES = Buffer.byteLength(
  wordProfilesMark(randomUUID(), {
    dev: 10n ** 20n - 1n,
    ino: 10n ** 20n - 1n,
    birthtimeNs: 10n ** 30n - 1n,
  }),
);

/** Every staged folder beside `to`, of any attempt. */
export function stagedFolders(to: string): string[] {
  const prefix = `${basename(to)}.moving-`;
  try {
    return readdirSync(dirname(to))
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dirname(to), name));
  } catch {
    return [];
  }
}

/** The checked staged copy from `from` waiting to go into place, if an attempt left one. */
export function verifiedStage(to: string, from: string): string | undefined {
  return stagedFolders(to).find((dir) => {
    const record = readMoveRecord(dir);
    return record?.state === "verified" && record.from === from;
  });
}

/**
 * Entries a folder may hold without holding saved work: the installer's
 * channel marker (docs/alpha.md) and what the move itself writes, beside
 * what a copy leaves behind.
 */
export const NOT_SAVED_WORK: ReadonlySet<string> = new Set([
  "update-channel.json",
  ".DS_Store",
  MOVE_RECORD,
  RETIRED_PROFILE_MARKER,
]);

/** Whether `dir` is a folder holding anything of the person's. */
export function holdsSavedWork(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => !NOT_SAVED_WORK.has(name) && !LEFT_BEHIND.has(name));
}

/**
 * The move this launch must make before it opens its folder, or null. Cheap
 * and synchronous: the app asks before Electron reads its folder. Due when
 * this app's folder carries a move not yet finished, a verified staged copy
 * waits to be put in place, or an older folder holds saved work it has not
 * moved or been told to keep apart from.
 */
export function dueMove(input: {
  appData: string;
  spelling: Spelling;
  flavor: BuildFlavor;
}): FolderMove | null {
  const to = join(input.appData, userDataFolderOf(input.spelling, input.flavor));
  const record = readMoveRecord(to);
  if (record)
    return record.state === "done" || record.state === "kept-own"
      ? null
      : { from: record.from, to };
  for (const name of olderUserDataFolders(input.spelling, input.flavor)) {
    const from = join(input.appData, name);
    if (verifiedStage(to, from)) return { from, to };
    if (!isProfileRetired(from) && holdsSavedWork(from)) return { from, to };
  }
  return null;
}

/**
 * Every path that names a folder: as given, and as the disk resolves it
 * where a link lies on the way. The app stores its paths as it named them;
 * git may have stored the resolved one.
 */
export function pathsOf(dir: string): string[] {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // Only the path as given.
  }
  return real === dir ? [dir] : [dir, real];
}
