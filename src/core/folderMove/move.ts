import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { folderHolder, predatesBoot } from "../helper/lock";
import { assertSavedDataCompatible } from "../storage/db";
import {
  acquireMoveLock,
  moveLockPathFor,
  processAlive,
  releaseMoveLock,
} from "../storage/moveLock";
import { isProfileRetired } from "../storage/retiredProfile";
import { readStartAtLogin } from "../storage/startAtLoginRecord";
import { mapClaudeSessions } from "./claudeSessions";
import { type CopyOptions, copyClones, copyTree, freeBytes } from "./copy";
import {
  type FolderMove,
  holdsSavedWork,
  NOT_SAVED_WORK,
  pathsOf,
  stagedFolderFor,
  stagedFolders,
  verifiedStage,
} from "./due";
import {
  type MoveRecord,
  type OutsideChange,
  readMoveRecord,
  writeMoveRecord,
  writeRetiredMarker,
} from "./record";
import {
  outsideGitLinks,
  rewriteDatabases,
  rewriteGitLinks,
  rewriteLinks,
  rewritePathFiles,
} from "./rewrite";
import { compareTrees, LEFT_BEHIND, surveyTree } from "./tree";

/**
 * The one-time move of a data folder into an app's own (the Infinitary
 * rename, FI3-1780 step 3; docs/saved-data-compatibility.md, "The one-time
 * move"). An app whose spelling has older spellings before it - Infinitary,
 * after Firstmate 3000 - finds an older folder of its flavor holding saved
 * work and brings it over before anything opens it: it checks, locks both
 * folders, copies the older one into a staged folder beside its own, checks
 * the copy file by file, rewrites the app's own paths in the copy, retires
 * the older folder - which stays as it was, the recovery copy - and renames
 * the staged folder into place. Firstmate 3000's own folders have no older
 * spelling, so in this build the move never wakes.
 *
 * Every step is written to the move's record before the step that depends
 * on it (./record.ts), so a move stopped anywhere - a crash, a quit, a full
 * disk - resumes from the last step written on the next launch, and never
 * copies over newer work.
 */

export type MovePhase = "checking" | "copying" | "verifying" | "finishing";

/**
 * How far a move is: the work done of the phase's total (`tree.ts`
 * `workOf`, a file's bytes and a fixed cost each), the total 0 while not
 * yet known.
 */
export type MoveProgress = { phase: MovePhase; done: number; total: number };

/** One folder as the both-folders question shows it: when it was last opened. */
export type FolderSummary = { path: string; lastOpened: number | undefined };

/** Why a move did not happen, or stopped. Nothing in either folder changed unless `committed`. */
export type MoveRefusal =
  /** Another launch is moving the same folders now. */
  | { reason: "busy" }
  /** The older app has the older folder open. */
  | { reason: "old-app-open" }
  /** The older app's background work holds the older folder's work. */
  | { reason: "old-work-running" }
  /** The older folder was saved by a newer version than this one reads. */
  | { reason: "unsupported" }
  | { reason: "no-space"; needed: number; free: number }
  | { reason: "failed"; detail: string; committed: boolean };

export type MoveOutcome =
  /** The work is in this app's folder; `startAtLogin` is what the older app last had. */
  | { kind: "moved"; startAtLogin: boolean | undefined }
  /** Both folders held work and the person kept this app's own. */
  | { kind: "kept" }
  | { kind: "nothing" }
  /** Both folders hold work: ask which one this app opens, then run again with the answer. */
  | { kind: "ask"; from: FolderSummary; to: FolderSummary }
  | { kind: "refused"; refusal: MoveRefusal };

/** The person's answer to the both-folders question. */
export type MoveChoice = "bring" | "keep";

export type MoveDeps = {
  platform: NodeJS.Platform;
  /** Claude's own records: `~/.claude` (`claude/claudeQuota.ts` `defaultClaudeConfigDir`). */
  claudeConfigDir: string;
  /** This computer's name, as Chromium writes it into its single-instance lock. */
  hostname: string;
  progress?: (progress: MoveProgress) => void;
  pid?: number;
  alive?: (pid: number) => boolean;
  now?: () => Date;
  cp?: string;
  /** The free bytes on the disk that holds a folder (`copy.ts` `freeBytes`). */
  free?: (dir: string) => number;
  /** Whether a copy into a folder clones its files (`copy.ts` `copyClones`). */
  clones?: (dir: string, platform: NodeJS.Platform) => boolean;
  /** The staged copy itself (`copy.ts` `copyTree`). */
  copy?: typeof copyTree;
};

/**
 * Takes away what earlier attempts left, as far as it can now: a copier
 * still writing into one keeps it there until a later launch, and that does
 * not hold this attempt up.
 */
function clearStages(to: string, keep?: string): void {
  for (const dir of stagedFolders(to)) {
    if (dir === keep) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // A later launch tries again.
    }
  }
}

/** Room left beyond what the copy writes: the databases are opened and folded, and the disk must not fill. */
export function marginFor(bytes: number): number {
  return Math.max(256 * 1024 * 1024, Math.ceil(bytes / 20));
}

function lastOpened(dir: string): number | undefined {
  for (const name of ["firstmate.db-wal", "firstmate.db"]) {
    try {
      return statSync(join(dir, name)).mtimeMs;
    } catch {
      // The next one.
    }
  }
  return undefined;
}

/**
 * Whether Chromium's single-instance lock in `dir` names a live process on
 * this computer. A lock written before this computer last started names a
 * window that ended with that start, whoever has its number now (`predatesBoot`).
 */
export function chromiumHolds(
  dir: string,
  hostname: string,
  alive: (pid: number) => boolean,
): boolean {
  const lock = join(dir, "SingletonLock");
  let target: string;
  try {
    target = readlinkSync(lock);
  } catch {
    return false;
  }
  if (predatesBoot(lock)) return false;
  const match = /^(.*)-(\d+)$/.exec(target);
  return Boolean(match && match[1] === hostname && alive(Number(match[2])));
}

function copyOptionsOf(deps: MoveDeps): CopyOptions {
  return { platform: deps.platform, ...(deps.cp ? { cp: deps.cp } : {}) };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Makes the move, or the part of it still to make. With both folders holding
 * work it answers `ask` until it is run again with the person's choice:
 * `bring` sets this app's own work aside in a folder beside it and moves the
 * older work in; `keep` records the choice in this app's folder and leaves
 * the older one as it is.
 */
export async function runMove(
  move: FolderMove,
  deps: MoveDeps,
  choice?: MoveChoice,
): Promise<MoveOutcome> {
  const { from, to } = move;
  const now = deps.now ?? (() => new Date());
  const alive = deps.alive ?? processAlive;
  const pid = deps.pid ?? process.pid;
  const copyOptions = copyOptionsOf(deps);

  const own = readMoveRecord(to);
  if (own?.state === "done" || own?.state === "kept-own") return { kind: "nothing" };
  const resuming = own;
  const toCommit = verifiedStage(to, from);
  if (!resuming && !toCommit) {
    if (isProfileRetired(from) || !holdsSavedWork(from)) return { kind: "nothing" };
    if (holdsSavedWork(to)) {
      if (!choice)
        return {
          kind: "ask",
          from: { path: from, lastOpened: lastOpened(from) },
          to: { path: to, lastOpened: lastOpened(to) },
        };
      if (choice === "keep") {
        writeMoveRecord(to, {
          schemaVersion: 1,
          state: "kept-own",
          from,
          to,
          at: now().toISOString(),
        });
        return { kind: "kept" };
      }
    }
    if (chromiumHolds(from, deps.hostname, alive))
      return { kind: "refused", refusal: { reason: "old-app-open" } };
    if (folderHolder(join(from, "work"), alive) !== null)
      return { kind: "refused", refusal: { reason: "old-work-running" } };
    try {
      assertSavedDataCompatible(from);
    } catch {
      return { kind: "refused", refusal: { reason: "unsupported" } };
    }
  }

  const fromLock = moveLockPathFor(from);
  const toLock = moveLockPathFor(to);
  mkdirSync(dirname(to), { recursive: true });
  if (!acquireMoveLock(fromLock, pid, now)) return { kind: "refused", refusal: { reason: "busy" } };
  if (!acquireMoveLock(toLock, pid, now)) {
    releaseMoveLock(fromLock, pid);
    return { kind: "refused", refusal: { reason: "busy" } };
  }
  try {
    if (resuming) return await finish(resuming, deps, copyOptions);
    let staged = toCommit;
    if (!staged) {
      const stagedOutcome = await stageMove(move, deps);
      if (stagedOutcome) return stagedOutcome;
      staged = stagedFolderFor(to, pid);
    }
    const record = readMoveRecord(staged);
    if (!record) throw new Error("The staged copy lost its record.");
    deps.progress?.({ phase: "finishing", done: 0, total: 0 });
    // From here the older folder is retired: the older app never opens it
    // again, and it stays as it was, the recovery copy.
    writeRetiredMarker(from, to, now().toISOString());
    commit(staged, to);
    const committed: MoveRecord = { ...record, state: "committed" };
    writeMoveRecord(to, committed);
    clearStages(to);
    return await finish(committed, deps, copyOptions);
  } catch (error) {
    const committed = readMoveRecord(to) !== undefined || isProfileRetired(from);
    return {
      kind: "refused",
      refusal: { reason: "failed", detail: said(error), committed },
    };
  } finally {
    releaseMoveLock(toLock, pid);
    releaseMoveLock(fromLock, pid);
  }
}

/**
 * Builds the staged copy and checks it, ending with its record `verified`;
 * answers a refusal instead when there is no room, and on any failure takes
 * the staged copy away, so nothing in either folder changed. Run inside
 * `runMove`, which holds both locks; alone only where nothing else moves
 * the folders (a test that stops a move after its copy).
 */
export async function stageMove(move: FolderMove, deps: MoveDeps): Promise<MoveOutcome | null> {
  const { from, to } = move;
  const now = deps.now ?? (() => new Date());
  const copyOptions = copyOptionsOf(deps);
  const staged = stagedFolderFor(to, deps.pid ?? process.pid);
  const progress = deps.progress;
  let setAside: string | undefined;
  let needed = 0;
  clearStages(to);
  rmSync(staged, { recursive: true, force: true });
  try {
    if (holdsSavedWork(to)) {
      setAside = `${to}-set-aside-${now().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(to, setAside);
    }
    mkdirSync(staged, { mode: 0o700 });
    progress?.({ phase: "checking", done: 0, total: 0 });
    const survey = await surveyTree(from, () =>
      progress?.({ phase: "checking", done: 0, total: 0 }),
    );
    const clones = (deps.clones ?? copyClones)(dirname(to), deps.platform);
    needed = (clones ? 0 : survey.bytes) + marginFor(survey.bytes);
    const free = (deps.free ?? freeBytes)(dirname(to));
    if (free < needed) {
      undoStage(staged, to, setAside);
      return { kind: "refused", refusal: { reason: "no-space", needed, free } };
    }
    let copied = 0;
    progress?.({ phase: "copying", done: 0, total: survey.work });
    await (deps.copy ?? copyTree)(from, staged, {
      ...copyOptions,
      done: (unit) => {
        copied += survey.unitWork.get(unit) ?? 0;
        progress?.({ phase: "copying", done: copied, total: survey.work });
      },
    });
    progress?.({ phase: "verifying", done: 0, total: survey.work });
    await compareTrees(from, staged, (work) =>
      progress?.({ phase: "verifying", done: work, total: survey.work }),
    );
    const froms = pathsOf(from);
    const outside: OutsideChange[] = outsideGitLinks(from, survey.gitLinks, froms, to);
    const rewritten = [
      ...rewriteDatabases(staged, froms, to),
      ...(await rewritePathFiles(staged, froms, to)),
      ...rewriteLinks(staged, survey.absoluteLinks, froms, to),
      ...(await rewriteGitLinks(staged, survey.gitLinks, froms, to)),
    ];
    writeMoveRecord(staged, {
      schemaVersion: 1,
      state: "verified",
      from,
      to,
      at: now().toISOString(),
      counts: {
        files: survey.files,
        dirs: survey.dirs,
        links: survey.links,
        bytes: survey.bytes,
      },
      skipped: survey.skipped,
      rewritten,
      outside,
      ...(setAside ? { setAside } : {}),
    });
    return null;
  } catch (error) {
    undoStage(staged, to, setAside);
    if (errorCode(error) === "ENOSPC") {
      const free = (deps.free ?? freeBytes)(dirname(to));
      return {
        kind: "refused",
        refusal: { reason: "no-space", needed: Math.max(needed, free + 1), free },
      };
    }
    return {
      kind: "refused",
      refusal: { reason: "failed", detail: said(error), committed: false },
    };
  }
}

/** Takes a staged copy away, and puts back the app's own work if the move had set it aside. */
function undoStage(staged: string, to: string, setAside: string | undefined): void {
  rmSync(staged, { recursive: true, force: true });
  if (setAside && !existsSync(to)) renameSync(setAside, to);
}

/**
 * Puts the staged copy in place of this app's folder in one rename. A folder
 * there with no saved work - an installer's channel marker and nothing else
 * - hands its entries to the staged copy first, so the marker the newer
 * install wrote is the one kept.
 */
function commit(staged: string, to: string): void {
  if (existsSync(to)) {
    for (const name of readdirSync(to)) {
      const entry = join(to, name);
      if (name === "update-channel.json") renameSync(entry, join(staged, name));
      else if (NOT_SAVED_WORK.has(name) || LEFT_BEHIND.has(name))
        rmSync(entry, { recursive: true, force: true });
      else throw new Error(`${name} appeared in ${to} during the move.`);
    }
  }
  // Onto an empty folder, or none: one rename either way.
  renameSync(staged, to);
}

/**
 * The steps after the commit, each safe to run again: git's links in
 * repositories outside the folders, then Claude's session folders, then the
 * record says done.
 */
async function finish(
  record: MoveRecord,
  deps: MoveDeps,
  copyOptions: CopyOptions,
): Promise<MoveOutcome> {
  deps.progress?.({ phase: "finishing", done: 0, total: 0 });
  const { from, to } = record;
  if (!isProfileRetired(from) && existsSync(from)) writeRetiredMarker(from, to, record.at);
  for (const change of record.outside ?? []) {
    let now: string;
    try {
      now = readFileSync(change.path, "utf8");
    } catch {
      continue;
    }
    // Changed since the move read it: someone else's change stands.
    if (now === change.before) writeFileSync(change.path, change.after);
  }
  const claude = await mapClaudeSessions({
    from: pathsOf(from),
    to: pathsOf(to),
    configDir: deps.claudeConfigDir,
    copy: copyOptions,
  });
  writeMoveRecord(to, {
    ...record,
    state: "done",
    ...(claude.length > 0 ? { claude } : {}),
  });
  return { kind: "moved", startAtLogin: readStartAtLogin(to) };
}

/** The folder name a move came from, for words a person reads. */
export function folderName(dir: string): string {
  return basename(dir);
}
