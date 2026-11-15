import { readFile, readlink } from "node:fs/promises";
import type { ProgramOutcome } from "@shared/leftoverPrograms";
import { RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import { cutText } from "@shared/textCut";
import { hostPlatform } from "../platform";
import { procOpenFiles, procPids, readLsof } from "./openFiles";
import { descendsFrom, type ProcessReading, readProcesses } from "./processResources";
import { programName, readWindowsPlaces } from "./windowsProcesses";
import { prefixesOf, under } from "./workingFolders";

/**
 * The programs still holding a closed task's folders, and their end
 * (docs/leftover-programs.md, "Programs holding its folders"). A holder has a file
 * open under one of the folders or works in one; on Windows it works in one
 * or runs a program file from one. Only the names under those folders, and
 * a program file's own name, are kept from what the system lists; no other
 * path, argument or environment of any program is read into the app.
 */

/** One program holding a folder: its number, its birth as the system lists it, and its name. */
export type FolderHolder = { pid: number; started: string; name: string };

/** Why no holder list came back: a system the app cannot read them on, or a failed read. */
export type HoldersReading =
  | { status: "checked"; holders: FolderHolder[] }
  | { status: "unsupported" | "unreadable" };

/** The grace period between the end request and the kill. */
export const HOLDER_GRACE_MS = 5000;
/** How long a kill gets to take effect before the program counts as surviving. */
const KILL_WAIT_MS = 2000;
const POLL_MS = 100;
/** A Mac's birth stamp counts whole seconds. */
const BIRTH_PRECISION_MS = 1000;

/**
 * The open files of this user's programs as lsof lists them on a Mac
 * (`-F pcn`: process, command, name), kept only for names under the
 * folders. The working folder is one of the names.
 */
export function holdersFromLsof(
  text: string,
  prefixes: readonly string[],
  excluded: readonly string[] = [],
): Map<number, string> {
  const holders = new Map<number, string>();
  let pid = 0;
  let name = "";
  for (const line of text.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      pid = Number(value);
      name = "";
    } else if (field === "c") name = value;
    else if (field === "n" && pid > 0 && under(value, prefixes) && !under(value, excluded))
      holders.set(pid, name);
  }
  return holders;
}

async function lsofHolders(
  prefixes: readonly string[],
  excluded: readonly string[],
): Promise<Map<number, string> | null> {
  const listed = await readLsof(["-F", "pcn"], {
    timeoutMs: RESOURCE_READ_TIMEOUT_MS * 4,
    maxBuffer: 256 * 1024 * 1024,
  });
  return listed === null ? null : holdersFromLsof(listed, prefixes, excluded);
}

/** Each of this user's programs' working folder and open files, read from /proc on Linux. */
async function procHolders(
  prefixes: readonly string[],
  excluded: readonly string[],
): Promise<Map<number, string> | null> {
  const pids = await procPids();
  if (!pids) return null;
  const holders = new Map<number, string>();
  for (const pid of pids) {
    const names: string[] = [];
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
    if (cwd) names.push(cwd);
    names.push(...(await procOpenFiles(pid)));
    const held = names.map((name) => name.replace(/ \(deleted\)$/, ""));
    if (!held.some((name) => under(name, prefixes) && !under(name, excluded))) continue;
    const comm = await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "");
    holders.set(pid, comm.trim());
  }
  return holders;
}

/**
 * Each of this account's programs that works in one of the folders or runs
 * a program file from one, on Windows, which keeps such a folder from being
 * removed. A file a program holds open there without either is not read.
 */
function windowsHolders(
  pids: readonly number[],
  prefixes: readonly string[],
  excluded: readonly string[],
): Map<number, string> | null {
  const places = readWindowsPlaces(pids, { image: true });
  if (!places) return null;
  const holders = new Map<number, string>();
  for (const [pid, { folder, image }] of places) {
    const held = [folder, image].filter((name): name is string => name !== undefined);
    if (held.some((name) => under(name, prefixes) && !under(name, excluded)))
      holders.set(pid, image ? programName(image) : "");
  }
  return holders;
}

/** The app's own process, its ancestors and every program it started: never a leftover. */
function ownFamily(
  rows: readonly ProcessReading[],
  appPid: number,
  protectDescendants: boolean,
): Set<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const family = new Set<number>([appPid]);
  for (let row = byPid.get(appPid); row && !family.has(row.parent); row = byPid.get(row.parent))
    family.add(row.parent);
  if (!protectDescendants) return family;
  for (const row of rows) if (descendsFrom(row.pid, appPid, byPid)) family.add(row.pid);
  return family;
}

export type HolderOptions = {
  /** Test runners end their descendants too, once their workers have finished. Defaults to true. */
  protectDescendants?: boolean;
  /** Folders still owned by the caller, such as a runner's browser awaiting its own teardown. */
  excludeFolders?: readonly string[];
  /** The app's own process number; its family is never a leftover. */
  appPid?: number;
  /** A program another live task owns (its group, by process group): never this task's leftover. */
  ownedElsewhere?: (row: ProcessReading) => boolean;
  /**
   * When the task started, in ms since the epoch: a program already running
   * before it, such as a terminal opened in the folder, is not its leftover.
   */
  startedAt?: number;
};

/**
 * The programs holding any of the folders that belong to no live task: not
 * the app or anything it started, and not a group another task declared.
 */
export async function findFolderHolders(
  folders: readonly string[],
  options: HolderOptions = {},
): Promise<HoldersReading> {
  const platform = hostPlatform();
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    return { status: "unsupported" };
  const prefixes = await prefixesOf(folders);
  if (prefixes.length === 0) return { status: "checked", holders: [] };
  const excluded = await prefixesOf(options.excludeFolders ?? []);
  // Windows names a holder from the table it lists, so it reads the table first.
  const listed = platform === "win32" ? await readProcesses() : undefined;
  if (listed === null) return { status: "unreadable" };
  const named =
    platform === "darwin"
      ? await lsofHolders(prefixes, excluded)
      : platform === "win32"
        ? windowsHolders(
            (listed ?? []).map((row) => row.pid),
            prefixes,
            excluded,
          )
        : await procHolders(prefixes, excluded);
  if (!named) return { status: "unreadable" };
  if (named.size === 0) return { status: "checked", holders: [] };
  const rows = listed ?? (await readProcesses());
  if (!rows) return { status: "unreadable" };
  const family = ownFamily(rows, options.appPid ?? process.pid, options.protectDescendants ?? true);
  const holders: FolderHolder[] = [];
  for (const row of rows) {
    const name = named.get(row.pid);
    if (name === undefined || row.exited || row.pid <= 1) continue;
    if (family.has(row.pid) || options.ownedElsewhere?.(row)) continue;
    if (
      options.startedAt !== undefined &&
      row.bornMs !== undefined &&
      row.bornMs + BIRTH_PRECISION_MS < options.startedAt
    )
      continue;
    holders.push({ pid: row.pid, started: row.started, name: cutText(name, 64) });
  }
  return { status: "checked", holders };
}

/** The program's birth now, or undefined once it is gone or a zombie. */
async function birthOf(pid: number): Promise<string | undefined | null> {
  const rows = await readProcesses();
  if (!rows) return null;
  const row = rows.find((candidate) => candidate.pid === pid);
  return row && !row.exited ? row.started : undefined;
}

function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(
  holder: FolderHolder,
  ms: number,
  wait: (ms: number) => Promise<void>,
): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const birth = await birthOf(holder.pid);
    if (birth !== null && birth !== holder.started) return true;
    if (Date.now() >= until) return false;
    await wait(POLL_MS);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ends one holder: an end request, then a kill after the grace period. Its
 * birth is checked before each, so a number the system gave a new program
 * meanwhile is never signalled. A holder read moments ago is signalled when
 * the table cannot be read; `onlyWhenRead`, for a number kept since an
 * earlier close, signals only when its birth reads equal, and otherwise
 * leaves it as it is (`survived`, never proven ended).
 */
export async function endHolder(
  holder: FolderHolder,
  options: { graceMs?: number; wait?: (ms: number) => Promise<void>; onlyWhenRead?: boolean } = {},
): Promise<ProgramOutcome> {
  const wait = options.wait ?? sleep;
  const result = (outcome: ProgramOutcome["outcome"]): ProgramOutcome => ({
    pid: holder.pid,
    name: holder.name,
    outcome,
    started: holder.started,
  });
  const before = await birthOf(holder.pid);
  if (options.onlyWhenRead && before !== holder.started)
    return result(before === null ? "survived" : "gone");
  if (before !== null && before !== holder.started) return result("gone");
  if (!signal(holder.pid, "SIGTERM")) return result("gone");
  if (await goneWithin(holder, options.graceMs ?? HOLDER_GRACE_MS, wait)) return result("ended");
  const still = await birthOf(holder.pid);
  if (options.onlyWhenRead && still !== holder.started)
    return result(still === null ? "survived" : "ended");
  if (still !== null && still !== holder.started) return result("ended");
  if (!signal(holder.pid, "SIGKILL")) return result("ended");
  return (await goneWithin(holder, KILL_WAIT_MS, wait)) ? result("killed") : result("survived");
}
