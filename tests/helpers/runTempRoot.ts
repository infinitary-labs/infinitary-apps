import { mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProgramOutcome } from "../../src/shared/leftoverPrograms";
import { RUN_ROOT_ENV, readScratchFolders, SCRATCH_FOLDERS_FILE } from "./runScratchFolders.ts";

/**
 * One private temp root per test run (vitest and Playwright alike).
 *
 * The run points TMPDIR at it before any test process starts, so every
 * `os.tmpdir()` in a test, a fixture, a stub and the app under test lands
 * inside it rather than in the shared system temp directory. A killed or
 * crashed run cannot leak into the shared directory either: its root is the
 * one entry it leaves, and the next run's sweep removes it once its owner
 * process is gone. The root's name carries the owner pid for that sweep.
 *
 * At the end of a run the root must be empty: `closeRunTempRoot` names
 * leftover files, ends programs holding the run's folders, and reports
 * every program even when it ended successfully.
 */

/** The one shared-temp entry every run root lives under. */
const RUNS_DIR_NAME = "infinitary-runs";

/**
 * Caches third-party tools keep in TMPDIR under one fixed name, reused run
 * after run rather than accumulating: Node's module compile cache (pnpm
 * turns it on). They go with the root, unreported. Playwright's transform
 * cache is pointed back at its usual shared home instead (openRunTempRoot).
 */
const TOOL_CACHES = [/^node-compile-cache$/];

export type RunTempRoot = {
  /** The private root this run's TMPDIR points at. */
  root: string;
  /** TMPDIR as it was before the run replaced it (undefined = unset). */
  previousTmpdir: string | undefined;
  previousRunRoot: string | undefined;
  abandoned: RunLeaks;
};

export type RunLeaks = {
  entries: string[];
  programs: ProgramOutcome[];
  unreadable: string[];
};

const emptyLeaks = (): RunLeaks => ({ entries: [], programs: [], unreadable: [] });

/** Reuses the task-close reader and birth-checked stop, but a finished run owns its children too. */
async function endPrograms(root: string, excludeFolders: string[] = []): Promise<RunLeaks> {
  // Node's build scripts also import ownerAlive. Load the core only in a
  // runner, whose resolver knows the core's shared-module aliases.
  const { findFolderHolders, endHolder } = await import("../../src/core/placed/folderHolders.ts");
  const leaked = emptyLeaks();
  const reading = await findFolderHolders([root, ...readScratchFolders(root)], {
    protectDescendants: false,
    excludeFolders,
  });
  if (reading.status === "unreadable") leaked.unreadable.push(root);
  if (reading.status === "checked")
    leaked.programs = await Promise.all(reading.holders.map((holder) => endHolder(holder)));
  return leaked;
}

function canRemove(leaked: RunLeaks): boolean {
  return leaked.unreadable.length === 0 && !leaked.programs.some((p) => p.outcome === "survived");
}

/** Whether a process with this pid is running, whoever owns it. */
export function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes run roots whose owning process no longer exists. */
async function sweepAbandonedRoots(runsDir: string): Promise<RunLeaks> {
  const leaked = emptyLeaks();
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return leaked;
  }
  for (const name of names) {
    const pid = Number(/^[a-z0-9]+-(\d+)-/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || ownerAlive(pid)) continue;
    const root = join(runsDir, name);
    const found = await endPrograms(root);
    leaked.programs.push(...found.programs);
    leaked.unreadable.push(...found.unreadable);
    if (canRemove(found)) rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  }
  return leaked;
}

/**
 * Creates this run's root under the shared temp directory and points TMPDIR
 * at it, so child processes started from here on inherit it. `kind` is a
 * short label (`unit`, `e2e`) that shows up in the root's name.
 */
export async function openRunTempRoot(kind: string): Promise<RunTempRoot> {
  const previousTmpdir = process.env.TMPDIR;
  const runsDir = join(tmpdir(), RUNS_DIR_NAME);
  mkdirSync(runsDir, { recursive: true });
  const abandoned = await sweepAbandonedRoots(runsDir);
  const root = mkdtempSync(join(runsDir, `${kind}-${process.pid}-`));
  // Playwright keys its transform cache off TMPDIR in each process that
  // loads it; keep it where the runner already put it, so it is reused.
  process.env.PWTEST_CACHE_DIR ??= join(
    tmpdir(),
    `playwright-transform-cache-${process.geteuid?.()}`,
  );
  const previousRunRoot = process.env[RUN_ROOT_ENV];
  process.env[RUN_ROOT_ENV] = root;
  process.env.TMPDIR = root;
  return { root, previousTmpdir, previousRunRoot, abandoned };
}

function remaining(root: string): string[] {
  try {
    return readdirSync(root)
      .filter(
        (name) => name !== SCRATCH_FOLDERS_FILE && !TOOL_CACHES.some((cache) => cache.test(name)),
      )
      .sort();
  } catch {
    return []; // Already gone: nothing is left in it.
  }
}

/**
 * Ends holders before removing the run's root, restores the environment,
 * and returns leftover entries, programs and unreadable checks. A survivor
 * or an unreadable check keeps the root for the next sweep. The shared
 * `infinitary-runs` directory goes once no other run is using it.
 *
 * `graceMs` is how long entries may still be disappearing: Playwright runs
 * the global teardown while its last workers are still exiting, and a
 * worker removes its scratch directories as it exits.
 */
export async function closeRunTempRoot(
  { root, previousTmpdir, previousRunRoot, abandoned }: RunTempRoot,
  graceMs = 0,
  ignoredEntries: readonly RegExp[] = [],
): Promise<RunLeaks> {
  const deadline = Date.now() + graceMs;
  let leaked = remaining(root);
  while (leaked.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    leaked = remaining(root);
  }
  try {
    // Vitest's browser closes after global teardown. Its known profiles and
    // artifacts still have a live owner; no other scratch folder is exempt.
    const ignored = leaked.filter((name) => ignoredEntries.some((pattern) => pattern.test(name)));
    const found = await endPrograms(
      root,
      ignored.map((name) => join(root, name)),
    );
    if (canRemove(found)) rmSync(root, { recursive: true, force: true, maxRetries: 2 });
    return {
      entries: leaked.filter((name) => !ignored.includes(name)),
      programs: [...abandoned.programs, ...found.programs],
      unreadable: [...abandoned.unreadable, ...found.unreadable],
    };
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousRunRoot === undefined) delete process.env[RUN_ROOT_ENV];
    else process.env[RUN_ROOT_ENV] = previousRunRoot;
    try {
      rmdirSync(join(tmpdir(), RUNS_DIR_NAME));
    } catch {
      // Another run still holds a root there, or it is already gone.
    }
  }
}

/**
 * The failure message for a run that left entries behind: every entry is
 * named, grouped by its prefix (the name without mkdtemp's random suffix)
 * so the creator is easy to find.
 */
export function leakReport(kind: string, leaks: RunLeaks): string {
  const leaked = leaks.entries;
  const groups = new Map<string, string[]>();
  for (const name of leaked) {
    const prefix = name.replace(/[A-Za-z0-9]{6}$/, "");
    groups.set(prefix, [...(groups.get(prefix) ?? []), name]);
  }
  const lines = [...groups].map(([prefix, names]) =>
    names.length === 1 ? `  ${names[0]}` : `  ${prefix}* x${names.length}: ${names.join(", ")}`,
  );
  return [
    ...(leaked.length
      ? [
          `The ${kind} run left ${leaked.length} temp ${leaked.length === 1 ? "entry" : "entries"} behind.`,
          "Whatever creates these must remove them (afterEach/afterAll, or tests/helpers/scratchDirs.ts):",
          ...lines,
        ]
      : []),
    ...(leaks.programs.length
      ? [
          `The ${kind} run left ${leaks.programs.length} program(s) behind. Stop and await each child before its test finishes:`,
          ...leaks.programs.map((p) => `  ${p.name} (pid ${p.pid}): ${p.outcome}`),
        ]
      : []),
    ...leaks.unreadable.map(
      (root) => `Could not check programs holding ${root}; kept it for the next run.`,
    ),
  ].join("\n");
}
