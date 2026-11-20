import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ownerAlive } from "../helpers/runTempRoot.ts";

/**
 * Each Playwright run keeps its own evidence (docs/testing.md, "Per-run e2e
 * evidence"): its result directories (traces, error contexts, failure pictures,
 * `testInfo.outputPath` files) and its JSON result live in
 * `test-results/runs/<run>/`, so a second run of the same working copy never
 * clears or overwrites the first's. Playwright clears a run's output
 * directory before its global setup runs, which used to be the whole of
 * `test-results/`. A spec saves its pictures and JSON through
 * `test.info().outputPath`, never to a fixed path, which two runs would share
 * (refused by tests/lint/e2e-run-evidence-path.grit).
 *
 * The directories also say which runs of a working copy are still going:
 * `pnpm build` refuses while one is (scripts/refuse-build-during-e2e.ts).
 */

/** Where every run's directory lives, relative to the working copy. */
export const RUNS_DIR = join("test-results", "runs");

/** Carries the runner's run name to its workers, which load the config again. */
const RUN_ENV = "INFINITARY_E2E_RUN";

/** Finished runs kept beside the live ones; older ones are removed. */
export const KEPT_RUNS = 10;

/** `20260930T194900Z-4242`: sorts by start, and names the runner's pid. */
export function runName(at: Date, pid: number): string {
  return `${at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${pid}`;
}

/** The runner's pid a run's name carries. */
export function runPid(name: string): number {
  return Number(/-(\d+)$/.exec(name)?.[1]);
}

/** When the runner named the run (epoch ms, to the second); NaN for any other name. */
function runStart(name: string): number {
  const at = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-\d+$/.exec(name);
  return at ? Date.parse(`${at[1]}-${at[2]}-${at[3]}T${at[4]}:${at[5]}:${at[6]}Z`) : Number.NaN;
}

/** When the process with this pid started (epoch ms), or undefined when none is running. */
export type ProcessStart = (pid: number) => number | undefined;

/** The system's answer, from the process's elapsed time (`ps`, to the second). */
export function processStart(pid: number): number | undefined {
  if (!ownerAlive(pid)) return undefined;
  const now = Date.now();
  const { stdout } = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  // [[days-]hours:]minutes:seconds
  const elapsed = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(stdout ?? "");
  if (!elapsed) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = elapsed;
  const secondsAgo =
    ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
  return now - secondsAgo * 1000;
}

/**
 * A run is going while its runner is: a process with the runner's pid that
 * started no later than the run did. A pid the system has since handed to
 * another process belongs to one that started after the runner exited, so
 * a finished run never reads as going. Both times are read to the second;
 * the margin covers that rounding.
 */
function runGoing(name: string, started: ProcessStart): boolean {
  const pid = runPid(name);
  const at = runStart(name);
  if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(at)) return false;
  const processStarted = started(pid);
  return processStarted !== undefined && processStarted <= at + 2_000;
}

/** The runs of this working copy that are still going, oldest first. */
export function liveRuns(workingCopy: string, started: ProcessStart = processStart): string[] {
  let names: string[];
  try {
    names = readdirSync(join(workingCopy, RUNS_DIR));
  } catch {
    return []; // No run of this working copy has started.
  }
  return names.filter((name) => runGoing(name, started)).sort();
}

/**
 * This run's directory. The runner names it; its workers inherit the name.
 * A name inherited from anywhere else (a parent that imported the config)
 * is never reused, because Playwright clears the directory a run starts with.
 */
export function runDir(env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  const inherited = env[RUN_ENV];
  const worker = env.TEST_WORKER_INDEX !== undefined;
  if (!inherited || (!worker && runPid(inherited) !== process.pid)) {
    env[RUN_ENV] = runName(now, process.pid);
  }
  return join(RUNS_DIR, env[RUN_ENV] as string);
}

/**
 * Housekeeping before a run's tests start, from its global setup: makes the
 * run's directory and keeps the newest finished runs. Nothing else in
 * `test-results/` is touched: no spec writes there, and what another tool
 * wrote there is not a run's to clear.
 */
export function tidyRunEvidence(
  workingCopy: string,
  ownDir: string,
  started: ProcessStart = processStart,
): void {
  const own = join(workingCopy, ownDir);
  mkdirSync(own, { recursive: true });
  const runs = join(workingCopy, RUNS_DIR);
  const others = readdirSync(runs).filter((name) => join(runs, name) !== own);
  const live = others.filter((name) => runGoing(name, started));
  const finished = others
    .filter((name) => !live.includes(name))
    .sort()
    .reverse();
  for (const name of finished.slice(KEPT_RUNS)) {
    rmSync(join(runs, name), { recursive: true, force: true, maxRetries: 2 });
  }
}
