import { createHash } from "node:crypto";
import type { BigIntStats, Dirent, Stats } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { createReadStream, lstat, readdir, readlink } from "./plainFs";

/**
 * Reading a data folder's tree for the one-time move (./move.ts): what it
 * holds before the copy, and whether the copy holds exactly that. Neither
 * read keeps the whole tree in memory - a folder with many working copies
 * holds millions of files - only the few entries the move rewrites later.
 */

/**
 * What the move leaves behind, by name at the folder's top: Chromium's own
 * locks and caches, which a new run makes again, retired working copies
 * waiting to be deleted, and the task channel's keys, which the app empties
 * each time it opens (docs/axi-commands.md). Nothing in them is saved work.
 */
export const LEFT_BEHIND: ReadonlySet<string> = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "RunningChromeVersion",
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "worktree-trash",
  "task-channel",
]);

/**
 * What the move leaves behind in `work/`, the folder a computer that runs
 * work keeps (docs/helper.md, "Where it keeps its data"): what Electron
 * itself writes there, the logs its run and its service manager append to,
 * the route a live controller renews, the lock of the run that holds it and
 * its display's key, beside the retired working copies and the task
 * channel's keys. A run, its service manager or a controller may still write
 * these while the move copies the folder; each is made again by the next
 * run, and none is saved work.
 */
export const WORK_LEFT_BEHIND: ReadonlySet<string> = new Set([
  "chromium",
  "service.log",
  "work.log",
  "route.json",
  "route.lock",
  "running.lock",
  "display.auth",
  "worktree-trash",
  "task-channel",
]);

/** Whether the move leaves the entry at these parts of the path behind. */
export function leftBehind(parts: readonly string[]): boolean {
  if (parts.length === 1) return LEFT_BEHIND.has(parts[0] as string);
  return parts.length === 2 && parts[0] === "work" && WORK_LEFT_BEHIND.has(parts[1] as string);
}

/**
 * Folders copied one entry at a time, so a move with many working copies
 * says its progress as each one is done rather than at the end of the one
 * folder that holds them all; `work/` too, so what it leaves behind stays.
 */
export const COPIED_ONE_BY_ONE: ReadonlySet<string> = new Set([
  "worktrees",
  "worktree-pool",
  "crewmates",
  "fleet",
  "work",
]);

/**
 * Folders copied one by one whose folders are copied one entry at a time in
 * turn: the warm pool keeps each project's spare working copies in a folder
 * of its own (`worktree-pool/<project>/<slot>`), so each spare working copy
 * is a unit of its own.
 */
export const COPIED_TWO_DEEP: ReadonlySet<string> = new Set(["worktree-pool"]);

/**
 * The unit a file, by its path relative to the folder, is copied in
 * (./copy.ts `copyUnits`). A folder of a folder copied two deep is split
 * there, so only a file inside it names a unit three parts deep.
 */
export function unitOf(parts: readonly string[]): string {
  const [top, child, grandchild] = parts;
  if (top === undefined || child === undefined || !COPIED_ONE_BY_ONE.has(top)) return top ?? "";
  return grandchild !== undefined && COPIED_TWO_DEEP.has(top)
    ? join(top, child, grandchild)
    : join(top, child);
}

/** A git working copy's link to its repository, or a repository's link back to one. */
export type GitLink = { path: string; kind: "worktree" | "admin" };

/**
 * How much work a file is, beside its bytes: opening, copying and checking a
 * small file costs about what reading a quarter of a megabyte does, so a
 * working copy's thousands of small files move the progress as their time
 * passes, not only the big files' bytes.
 */
export const FILE_WORK = 256 * 1024;

/** The work a file of this size is (`FILE_WORK`). */
export function workOf(size: number): number {
  return size + FILE_WORK;
}

/** What a walk of the folder found, beyond its counts. */
export type TreeSurvey = {
  files: number;
  dirs: number;
  links: number;
  bytes: number;
  /** The work the whole copy is (`workOf` each file). */
  work: number;
  /** The work of each unit the copy goes by (`unitOf`). */
  unitWork: Map<string, number>;
  /** Sockets and pipes: live endpoints, never copied. Relative paths. */
  skipped: string[];
  /** Relative paths of symbolic links whose target is an absolute path. */
  absoluteLinks: string[];
  /** Relative paths of git's link files: a working copy's `.git` file, a repository's `worktrees/<id>/gitdir`. */
  gitLinks: GitLink[];
};

/** Called as a walk goes, with the work counted or checked so far. */
export type TreeProgress = (work: number) => void;

function kindOf(stats: Stats | BigIntStats | Dirent): "dir" | "file" | "link" | "other" {
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

function relative(parts: readonly string[]): string {
  return parts.join(sep);
}

function isGitLink(parts: readonly string[]): GitLink["kind"] | null {
  const name = parts.at(-1);
  if (name === ".git") return "worktree";
  if (name === "gitdir" && parts.at(-3) === "worktrees") return "admin";
  return null;
}

/** Folders read at once, and files of each read at once: enough to keep a disk busy, few enough to stay under the open-file limit. */
const FOLDERS_AT_ONCE = 8;
const FILES_AT_ONCE = 8;

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += FILES_AT_ONCE)
    await Promise.all(items.slice(start, start + FILES_AT_ONCE).map(run));
}

/**
 * Visits every folder under the top, several at once: `visit` reads one
 * folder and answers the folders inside it to visit next. Only the queue of
 * folders still to visit is held, never the tree. The first failure stops
 * the walk and is thrown.
 */
async function walkFolders(visit: (parts: string[]) => Promise<string[][]>): Promise<void> {
  const queue: string[][] = [[]];
  let active = 0;
  let failed: unknown;
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (failed !== undefined) return;
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < FOLDERS_AT_ONCE && queue.length > 0) {
        const parts = queue.pop() as string[];
        active++;
        visit(parts).then(
          (inside) => {
            active--;
            queue.push(...inside);
            pump();
          },
          (error: unknown) => {
            failed = error;
            reject(error);
          },
        );
      }
    };
    pump();
  });
}

async function sortedEntries(dir: string): Promise<Dirent[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Counts what the move copies from `root`: every entry but those left behind
 * (`leftBehind`), with the sockets and pipes it skips, the absolute symbolic
 * links and git's link files it rewrites after.
 */
export async function surveyTree(root: string, progress?: TreeProgress): Promise<TreeSurvey> {
  const survey: TreeSurvey = {
    files: 0,
    dirs: 0,
    links: 0,
    bytes: 0,
    work: 0,
    unitWork: new Map(),
    skipped: [],
    absoluteLinks: [],
    gitLinks: [],
  };
  await walkFolders(async (parts) => {
    const entries = (await sortedEntries(join(root, ...parts))).filter(
      (entry) => !leftBehind([...parts, entry.name]),
    );
    const inside: string[][] = [];
    await inBatches(entries, async (entry) => {
      const at = [...parts, entry.name];
      const path = join(root, ...at);
      const kind = kindOf(entry);
      if (kind === "dir") {
        survey.dirs++;
        inside.push(at);
      } else if (kind === "link") {
        survey.links++;
        if (isAbsolute(await readlink(path))) survey.absoluteLinks.push(relative(at));
      } else if (kind === "file") {
        survey.files++;
        const { size } = await lstat(path);
        survey.bytes += size;
        survey.work += workOf(size);
        const unit = unitOf(at);
        survey.unitWork.set(unit, (survey.unitWork.get(unit) ?? 0) + workOf(size));
        const link = isGitLink(at);
        if (link) survey.gitLinks.push({ path: relative(at), kind: link });
        progress?.(survey.work);
      } else {
        survey.skipped.push(relative(at));
      }
    });
    return inside;
  });
  return survey;
}

/** A difference between the folder and its copy, said as a reason a move stops. */
export class CopyMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly what: string,
  ) {
    super(`The copy of ${path} does not match (${what}).`);
    this.name = "CopyMismatchError";
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Checks that `copy` holds exactly what the move copies from `root`: the
 * same names, kinds, sizes and permission bits, the same link targets, and
 * every file the same bytes. A file in a unit the disk cloned (`cloned`, by
 * `unitOf`) shares its source's bytes, so the same size and modification
 * time, to the nanosecond, prove it unchanged since the clone; every other
 * file, written byte by byte, is checked by its hash. Throws
 * `CopyMismatchError` on the first difference; answers the work checked
 * (`workOf`).
 */
export async function compareTrees(
  root: string,
  copy: string,
  progress?: TreeProgress,
  cloned: (unit: string) => boolean = () => false,
): Promise<number> {
  let checked = 0;
  await walkFolders(async (parts) => {
    const from = (await sortedEntries(join(root, ...parts))).filter(
      (entry) => !leftBehind([...parts, entry.name]) && kindOf(entry) !== "other",
    );
    const to = await sortedEntries(join(copy, ...parts));
    const names = (entries: Dirent[]) => entries.map((entry) => entry.name).join("\0");
    if (names(from) !== names(to)) {
      const missing = from.find((entry) => !to.some((other) => other.name === entry.name));
      const extra = to.find((entry) => !from.some((other) => other.name === entry.name));
      throw new CopyMismatchError(
        relative([...parts, (missing ?? extra)?.name ?? ""]),
        missing ? "missing from the copy" : "only in the copy",
      );
    }
    const inside: string[][] = [];
    await inBatches(from, async (entry) => {
      const at = [...parts, entry.name];
      const source = join(root, ...at);
      const target = join(copy, ...at);
      const [a, b] = await Promise.all([
        lstat(source, { bigint: true }),
        lstat(target, { bigint: true }),
      ]);
      const kind = kindOf(a);
      if (kindOf(b) !== kind) throw new CopyMismatchError(relative(at), "a different kind");
      if (kind === "link") {
        if ((await readlink(source)) !== (await readlink(target)))
          throw new CopyMismatchError(relative(at), "a different link target");
        return;
      }
      if ((a.mode & 0o7777n) !== (b.mode & 0o7777n))
        throw new CopyMismatchError(relative(at), "different permissions");
      if (kind === "dir") {
        inside.push(at);
        return;
      }
      if (a.size !== b.size) throw new CopyMismatchError(relative(at), "a different size");
      if (cloned(unitOf(at))) {
        if (a.mtimeNs !== b.mtimeNs) throw new CopyMismatchError(relative(at), "a different time");
      } else {
        const [left, right] = await Promise.all([hashFile(source), hashFile(target)]);
        if (left !== right) throw new CopyMismatchError(relative(at), "different contents");
      }
      checked += workOf(Number(a.size));
      progress?.(checked);
    });
    return inside;
  });
  return checked;
}
