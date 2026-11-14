import { readlink, realpath } from "node:fs/promises";
import { sep } from "node:path";
import { RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import { hostPlatform } from "../platform";
import { readLsof } from "./openFiles";

/**
 * The folder each program works in, and the open task whose folders hold it
 * (docs/helper.md, "Running tasks’ resource use"). A test runner left behind
 * when its shell ended is reparented away from the task's tree, but it still
 * works in the task's working copy or temporary folder, so its memory counts
 * against that task rather than against programs no task owns.
 */

/** A live task here and the folders it works in: its working copy and temporary folder. */
export type TaskFolders = { taskId: string; folders: readonly string[] };

/** The folders' own spellings and their real paths, without a trailing separator. */
export async function prefixesOf(folders: readonly string[]): Promise<string[]> {
  const prefixes = new Set<string>();
  for (const folder of folders) {
    const trimmed = folder.replace(/[\\/]+$/, "");
    if (!trimmed) continue;
    prefixes.add(trimmed);
    const real = await realpath(trimmed).catch(() => undefined);
    if (real) prefixes.add(real.replace(/[\\/]+$/, ""));
  }
  return [...prefixes];
}

/** The path is one of the folders or inside one. */
export function under(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}${sep}`));
}

/** Each program's working folder from lsof's `-d cwd -F pn` listing on a Mac. */
export function workingFoldersFromLsof(text: string): Map<number, string> {
  const folders = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") pid = Number(value);
    else if (line[0] === "n" && Number.isSafeInteger(pid) && pid > 0) folders.set(pid, value);
  }
  return folders;
}

/**
 * Each of this user's programs' working folder, or null when none could be
 * read. Only the folder is read, never arguments or environment, and it
 * never leaves this computer.
 */
export async function readWorkingFolders(
  pids: readonly number[],
): Promise<Map<number, string> | null> {
  const platform = hostPlatform();
  if (platform === "darwin") {
    const uid = process.getuid?.();
    const listed = await readLsof(
      ["-a", "-d", "cwd", ...(uid === undefined ? [] : ["-u", String(uid)]), "-F", "pn"],
      { timeoutMs: RESOURCE_READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    return listed === null ? null : workingFoldersFromLsof(listed);
  }
  if (platform !== "linux") return null;
  const folders = new Map<number, string>();
  // Serial, like the processor read, so a large table cannot exhaust file descriptors.
  for (const pid of pids) {
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
    if (cwd) folders.set(pid, cwd.replace(/ \(deleted\)$/, ""));
  }
  return folders;
}

/** Which task's folders hold each program's working folder; a program in none is left out. */
export async function folderOwners(
  workingFolders: ReadonlyMap<number, string>,
  tasks: readonly TaskFolders[],
): Promise<Map<number, string>> {
  const places = await Promise.all(
    tasks.map(async (task) => ({ taskId: task.taskId, prefixes: await prefixesOf(task.folders) })),
  );
  const owners = new Map<number, string>();
  if (places.every((place) => place.prefixes.length === 0)) return owners;
  for (const [pid, folder] of workingFolders) {
    const place = places.find((candidate) => under(folder, candidate.prefixes));
    if (place) owners.set(pid, place.taskId);
  }
  return owners;
}
