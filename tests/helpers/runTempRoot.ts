import { mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * At the end of a run the root must be empty: whatever is still in it was
 * created and never removed, and `closeRunTempRoot` names it.
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
};

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
function sweepAbandonedRoots(runsDir: string): void {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^[a-z0-9]+-(\d+)-/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || ownerAlive(pid)) continue;
    rmSync(join(runsDir, name), { recursive: true, force: true, maxRetries: 2 });
  }
}

/**
 * Creates this run's root under the shared temp directory and points TMPDIR
 * at it, so child processes started from here on inherit it. `kind` is a
 * short label (`unit`, `e2e`) that shows up in the root's name.
 */
export function openRunTempRoot(kind: string): RunTempRoot {
  const previousTmpdir = process.env.TMPDIR;
  const runsDir = join(tmpdir(), RUNS_DIR_NAME);
  mkdirSync(runsDir, { recursive: true });
  sweepAbandonedRoots(runsDir);
  const root = mkdtempSync(join(runsDir, `${kind}-${process.pid}-`));
  // Playwright keys its transform cache off TMPDIR in each process that
  // loads it; keep it where the runner already put it, so it is reused.
  process.env.PWTEST_CACHE_DIR ??= join(
    tmpdir(),
    `playwright-transform-cache-${process.geteuid?.()}`,
  );
  process.env.TMPDIR = root;
  return { root, previousTmpdir };
}

function remaining(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => !TOOL_CACHES.some((cache) => cache.test(name)))
      .sort();
  } catch {
    return []; // Already gone: nothing is left in it.
  }
}

/**
 * Removes the run's root, restores TMPDIR and returns the names of the
 * entries that were still in it (empty = nothing leaked). The shared
 * `infinitary-runs` directory goes too once no other run is using it.
 *
 * `graceMs` is how long entries may still be disappearing: Playwright runs
 * the global teardown while its last workers are still exiting, and a
 * worker removes its scratch directories as it exits.
 */
export async function closeRunTempRoot(
  { root, previousTmpdir }: RunTempRoot,
  graceMs = 0,
): Promise<string[]> {
  const deadline = Date.now() + graceMs;
  let leaked = remaining(root);
  while (leaked.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    leaked = remaining(root);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  try {
    rmdirSync(join(tmpdir(), RUNS_DIR_NAME));
  } catch {
    // Another run still holds a root there, or it is already gone.
  }
  return leaked;
}

/**
 * The failure message for a run that left entries behind: every entry is
 * named, grouped by its prefix (the name without mkdtemp's random suffix)
 * so the creator is easy to find.
 */
export function leakReport(kind: string, leaked: string[]): string {
  const groups = new Map<string, string[]>();
  for (const name of leaked) {
    const prefix = name.replace(/[A-Za-z0-9]{6}$/, "");
    groups.set(prefix, [...(groups.get(prefix) ?? []), name]);
  }
  const lines = [...groups].map(([prefix, names]) =>
    names.length === 1 ? `  ${names[0]}` : `  ${prefix}* x${names.length}: ${names.join(", ")}`,
  );
  return [
    `The ${kind} run left ${leaked.length} temp ${leaked.length === 1 ? "entry" : "entries"} behind.`,
    "Whatever creates these must remove them (afterEach/afterAll, or tests/helpers/scratchDirs.ts):",
    ...lines,
  ].join("\n");
}
