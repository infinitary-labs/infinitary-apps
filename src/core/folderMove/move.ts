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
import { folderHolder, holderAlive, processAlive } from "../helper/lock";
import { assertSavedDataCompatible } from "../storage/db";
import {
  acquireMoveLock,
  moveLockHeld,
  moveLockPathFor,
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
import {
  compareTrees,
  LEFT_BEHIND,
  surveyTree,
  type TreeSurvey,
  type UnitKind,
  unitKindOf,
} from "./tree";

/**
 * The one-time move of a data folder into an app's own (the Infinitary
 * rename, FI3-1780 step 3; docs/saved-data-compatibility.md, "The one-time
 * move"). An app whose spelling has older spellings before it - Infinitary,
 * after Firstmate 3000 - finds an older folder of its flavor holding saved
 * work and brings it over before anything opens it: it checks, locks both
 * folders, copies the older one into a staged folder beside its own, checks
 * the copy file by file - a clone by its size and time, a file written
 * byte by byte by its hash - rewrites the app's own paths in the copy, retires
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

/** What a move carries, once counted: what the window says it is copying and why it takes long. */
export type MoveCount = {
  /** Its files, folders and links. */
  entries: number;
  files: number;
  bytes: number;
  /** Task working copies and the warm pool's spare ones. */
  workingCopies: number;
  /** The files inside those working copies. */
  workingCopyFiles: number;
};

/** One unit the copy goes by, as the window names it (`tree.ts` `unitKindOf`). */
export type MoveItem = {
  kind: UnitKind;
  /** The task's short name, or the project's, where the kind has one. */
  name?: string;
  /** Its place among the units of its kind, from 1, and how many there are. */
  index: number;
  of: number;
  files: number;
};

/**
 * How far a move is: the files, folders and links done of the phase's
 * total, the total 0 while not yet known. While counting, `bytes` is the
 * bytes counted so far; once counted, `counted` says what the move
 * carries, and while copying `item` is the unit started last.
 */
export type MoveProgress = {
  phase: MovePhase;
  done: number;
  total: number;
  bytes?: number;
  counted?: MoveCount;
  item?: MoveItem;
};

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
  /**
   * Stops a move before its copy is checked: the count, the copy or the
   * check ends, the staged copy goes and the app's own work is put back, so
   * nothing in either folder changed and the next launch starts again.
   */
  signal?: AbortSignal;
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
 * window that ended with that start, whoever has its number now (`holderAlive`).
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
  const match = /^(.*)-(\d+)$/.exec(target);
  return Boolean(match && match[1] === hostname && holderAlive(lock, Number(match[2]), alive));
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

/** The units of each kind, in the order the copy takes them. */
function unitsByKind(survey: TreeSurvey): Map<UnitKind, string[]> {
  const kinds = new Map<UnitKind, string[]>();
  for (const unit of [...survey.unitEntries.keys()].sort()) {
    const { kind } = unitKindOf(unit);
    kinds.set(kind, [...(kinds.get(kind) ?? []), unit]);
  }
  return kinds;
}

function countOf(survey: TreeSurvey, kinds: Map<UnitKind, string[]>): MoveCount {
  const copies = [...(kinds.get("working-copy") ?? []), ...(kinds.get("spare-working-copy") ?? [])];
  return {
    entries: survey.entries,
    files: survey.files,
    bytes: survey.bytes,
    workingCopies: copies.length,
    workingCopyFiles: copies.reduce((sum, unit) => sum + (survey.unitFiles.get(unit) ?? 0), 0),
  };
}

function itemOf(unit: string, survey: TreeSurvey, kinds: Map<UnitKind, string[]>): MoveItem {
  const { kind, name } = unitKindOf(unit);
  const same = kinds.get(kind) ?? [unit];
  return {
    kind,
    ...(name ? { name } : {}),
    index: same.indexOf(unit) + 1,
    of: same.length,
    files: survey.unitFiles.get(unit) ?? 0,
  };
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
    if (!moveLockHeld(moveLockPathFor(to), alive)) restoreSetAside(to);
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
      setAside = join(
        dirname(to),
        `${setAsidePrefix(to)}${now().toISOString().replace(/[:.]/g, "-")}`,
      );
      renameSync(to, setAside);
    }
    mkdirSync(staged, { mode: 0o700 });
    progress?.({ phase: "checking", done: 0, total: 0 });
    const survey = await surveyTree(
      from,
      (entries, bytes) => progress?.({ phase: "checking", done: entries, total: 0, bytes }),
      deps.signal,
    );
    const kinds = unitsByKind(survey);
    const counted = countOf(survey, kinds);
    const clones = (deps.clones ?? copyClones)(dirname(to), deps.platform);
    needed = (clones ? 0 : survey.bytes) + marginFor(survey.bytes);
    const free = (deps.free ?? freeBytes)(dirname(to));
    if (free < needed) {
      undoStage(staged, to, setAside);
      return { kind: "refused", refusal: { reason: "no-space", needed, free } };
    }
    // The folders that hold units are made first; each unit is credited as
    // its copier names its entries, and in full once it is in.
    let copied = survey.entries;
    for (const entries of survey.unitEntries.values()) copied -= entries;
    let item: MoveItem | undefined;
    const credited = new Map<string, number>();
    const credit = (unit: string, entries: number) => {
      const was = credited.get(unit) ?? 0;
      const now = Math.min(entries, survey.unitEntries.get(unit) ?? 0);
      credited.set(unit, now);
      copied += now - was;
      progress?.({
        phase: "copying",
        done: copied,
        total: survey.entries,
        counted,
        ...(item ? { item } : {}),
      });
    };
    const cloned = new Set<string>();
    progress?.({ phase: "copying", done: copied, total: survey.entries, counted });
    await (deps.copy ?? copyTree)(from, staged, {
      ...copyOptions,
      ...(deps.signal ? { signal: deps.signal } : {}),
      started: (unit) => {
        item = itemOf(unit, survey, kinds);
        credit(unit, credited.get(unit) ?? 0);
      },
      copied: (unit, entries) => credit(unit, (credited.get(unit) ?? 0) + entries),
      done: (unit, clone) => {
        if (clone) cloned.add(unit);
        credit(unit, survey.unitEntries.get(unit) ?? 0);
      },
    });
    progress?.({ phase: "verifying", done: 0, total: survey.entries, counted });
    await compareTrees(
      from,
      staged,
      (entries) =>
        progress?.({ phase: "verifying", done: entries, total: survey.entries, counted }),
      (unit) => cloned.has(unit),
      deps.signal,
    );
    const froms = pathsOf(from);
    // A stop asked before the copy is checked and rewritten still changes nothing.
    deps.signal?.throwIfAborted();
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

function setAsidePrefix(to: string): string {
  return `${basename(to)}-set-aside-`;
}

/**
 * Puts back the app's own work a launch set aside and was stopped hard
 * before its copy was checked (INF-3307): only that copy's record would have
 * named the folder, so nothing else points at it. Run before the question,
 * with no move under way, no checked copy waiting and the older folder not
 * yet retired, so the newest set-aside folder is the stopped launch's.
 */
function restoreSetAside(to: string): void {
  if (holdsSavedWork(to)) return;
  let names: string[];
  try {
    names = readdirSync(dirname(to));
  } catch {
    return;
  }
  const newest = names
    .filter((name) => name.startsWith(setAsidePrefix(to)))
    .sort()
    .at(-1);
  if (!newest) return;
  // As a checked copy goes in: an installer's channel marker written since is kept.
  commit(join(dirname(to), newest), to);
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
