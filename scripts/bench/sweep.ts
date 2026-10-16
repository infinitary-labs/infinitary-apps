/**
 * The empty-patch sweep (S0's exit criterion): every task's verifier, run
 * on the pristine base state, timed. It proves each verifier runs on Apple
 * container under Rosetta and inside its budget, and gives S3 the verifier
 * share of an attempt's wall clock.
 *
 * Images come and go in waves no larger than the worker count: a worker
 * pulls its task's image, grades the empty patch, and deletes the image
 * again unless it was already cached before the sweep (an image unpacks to
 * about 4.5 GB, so all 113 would not fit beside the machine's own data).
 * Rows append to a JSONL file as they finish, so a stopped sweep resumes.
 *
 * An infrastructure failure (the verifier timed out, wrote no reward, wrote
 * its own -1, or the container or pull failed) is retried once, straight
 * away; the row keeps the first failure. A pull refused at the free-disk
 * floor stops the sweep instead of recording anything.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  DISK_FLOOR_GB,
  DiskFloorError,
  deleteImage,
  localImages,
  MAX_TASK_CONTAINERS,
  pullImage,
} from "./containers.ts";
import type { BenchTask } from "./pool.ts";
import { freeDiskGb } from "./pool.ts";
import { runVerifier, type VerifierResult } from "./verifierRunner.ts";

export type SweepRow = {
  task: string;
  language: string;
  /** The grader's reward: 0 or 1, or -1 when the final attempt was an infrastructure failure. */
  reward: number;
  partial: number | null;
  f2pTotal: number | null;
  f2pPassed: number | null;
  p2pTotal: number | null;
  p2pPassed: number | null;
  verifierSeconds: number;
  budgetSeconds: number;
  pullSeconds: number | null;
  timedOut: boolean;
  exitCode: number;
  /** The final attempt's infrastructure failure; null when the verifier graded. */
  failure: string | null;
  /** 1, or 2 when the first attempt was an infrastructure failure. */
  attempts: number;
  /** The first attempt's failure when it was retried. */
  firstFailure: string | null;
  logsDir: string;
  at: string;
};

export function readRows(path: string): SweepRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SweepRow);
}

/** The tasks a resumed sweep still has to run: those with no row yet, in pool order. */
export function pendingTasks(tasks: BenchTask[], rows: SweepRow[]): BenchTask[] {
  const done = new Set(rows.map((row) => row.task));
  return tasks.filter((task) => !done.has(task.id));
}

/** Why a verifier run did not grade, or null when it did. */
export function failureOf(result: VerifierResult): string | null {
  if (result.timedOut) return `timeout after ${result.wallSeconds} s`;
  if (!result.scores) return `no reward.json (exit ${result.exitCode})`;
  if (result.scores.reward < 0) return `the verifier wrote reward -1 (exit ${result.exitCode})`;
  return null;
}

/** What the sweep drives; `defaultDeps` is the real machine, tests pass fakes. */
export type SweepDeps = {
  cachedImages: () => Set<string>;
  pull: (task: BenchTask) => Promise<{ seconds: number }>;
  grade: (task: BenchTask) => Promise<VerifierResult>;
  deleteImage: (task: BenchTask) => void;
  freeDiskGb: () => number;
  append: (path: string, line: string) => void;
  readRows: (path: string) => SweepRow[];
};

export const defaultDeps: SweepDeps = {
  cachedImages: localImages,
  pull: (task) => pullImage(task, DISK_FLOOR_GB),
  grade: (task) => runVerifier(task, Buffer.alloc(0)),
  deleteImage,
  freeDiskGb: () => freeDiskGb(),
  append: (path, line) => appendFileSync(path, line),
  readRows,
};

export async function sweepEmptyPatches(opts: {
  tasks: BenchTask[];
  rowsPath: string;
  concurrency: number;
  keepImages: boolean;
  log: (line: string) => void;
  deps?: SweepDeps;
}): Promise<SweepRow[]> {
  const deps = opts.deps ?? defaultDeps;
  if (opts.concurrency < 1 || opts.concurrency > MAX_TASK_CONTAINERS) {
    throw new Error(`concurrency must be 1 to ${MAX_TASK_CONTAINERS}`);
  }
  const before = deps.readRows(opts.rowsPath);
  const queue = pendingTasks(opts.tasks, before);
  const cachedBefore = deps.cachedImages();
  opts.log(`${before.length} rows already in ${opts.rowsPath}; ${queue.length} to run`);
  let stopped: unknown;
  const worker = async () => {
    for (let task = queue.shift(); task && stopped === undefined; task = queue.shift()) {
      let row: SweepRow;
      try {
        row = await sweepOne(task, cachedBefore.has(task.image), opts.keepImages, deps);
      } catch (error) {
        stopped ??= error;
        return;
      }
      deps.append(opts.rowsPath, `${JSON.stringify(row)}\n`);
      const retried = row.firstFailure ? `, retried after: ${row.firstFailure}` : "";
      opts.log(
        `${task.id} (${task.language}): reward ${row.reward}, partial ${row.partial ?? "-"}, verifier ${row.verifierSeconds}s, pull ${row.pullSeconds ?? "cached"}s${row.failure ? `, FAILED: ${row.failure}` : ""}${retried}, ${deps.freeDiskGb().toFixed(0)} GB free`,
      );
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  if (stopped !== undefined) throw stopped;
  return deps.readRows(opts.rowsPath);
}

type Attempt = {
  result: VerifierResult | null;
  failure: string | null;
  pullSeconds: number | null;
};

async function sweepOne(
  task: BenchTask,
  cached: boolean,
  keepImages: boolean,
  deps: SweepDeps,
): Promise<SweepRow> {
  let pulled = cached;
  const attempt = async (): Promise<Attempt> => {
    let pullSeconds: number | null = null;
    try {
      if (!pulled) {
        pullSeconds = Math.round((await deps.pull(task)).seconds);
        pulled = true;
      }
      const result = await deps.grade(task);
      return { result, failure: failureOf(result), pullSeconds };
    } catch (error) {
      if (error instanceof DiskFloorError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { result: null, failure: `error: ${message}`, pullSeconds };
    }
  };
  try {
    const first = await attempt();
    const final = first.failure ? await attempt() : first;
    return toRow(task, final, {
      attempts: first.failure ? 2 : 1,
      firstFailure: first.failure,
      pullSeconds: first.pullSeconds ?? final.pullSeconds,
    });
  } finally {
    if (pulled && !cached && !keepImages) deps.deleteImage(task);
  }
}

function toRow(
  task: BenchTask,
  { result, failure }: Attempt,
  extra: { attempts: number; firstFailure: string | null; pullSeconds: number | null },
): SweepRow {
  const scores = result?.scores ?? null;
  return {
    task: task.id,
    language: task.language,
    reward: failure ? -1 : (scores?.reward ?? -1),
    partial: numberOrNull(scores?.partial),
    f2pTotal: numberOrNull(scores?.f2p_total),
    f2pPassed: numberOrNull(scores?.f2p_passed),
    p2pTotal: numberOrNull(scores?.p2p_total),
    p2pPassed: numberOrNull(scores?.p2p_passed),
    verifierSeconds: result?.wallSeconds ?? 0,
    budgetSeconds: task.verifier.timeoutSec,
    pullSeconds: extra.pullSeconds,
    timedOut: result?.timedOut ?? false,
    exitCode: result?.exitCode ?? -1,
    failure,
    attempts: extra.attempts,
    firstFailure: extra.firstFailure,
    logsDir: result?.logsDir ?? "",
    at: new Date().toISOString(),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** A verifier past this share of its budget on the empty patch is named as slow under Rosetta. */
export const SLOW_SHARE = 0.5;

/** The committed table S1 reads: one row per task, sorted by id, plus the named outliers. */
export function summarize(rows: SweepRow[], host: string) {
  const sorted = [...rows].sort((a, b) => a.task.localeCompare(b.task));
  const graded = sorted.filter((row) => row.failure === null);
  const seconds = graded.map((row) => row.verifierSeconds).sort((a, b) => a - b);
  const pick = (q: number) =>
    seconds.length === 0
      ? null
      : seconds[Math.min(seconds.length - 1, Math.floor(q * seconds.length))];
  return {
    what: "DeepSWE verifiers on the empty patch (the pristine base), each in its own task container: Apple container, linux/amd64 under Rosetta, the task's 2 CPUs and 8 GB, offline, up to three at once",
    host,
    tasks: sorted.length,
    graded: graded.length,
    infrastructureFailures: sorted
      .filter((row) => row.failure !== null)
      .map((row) => ({ task: row.task, failure: row.failure, firstFailure: row.firstFailure })),
    retried: sorted
      .filter((row) => row.attempts > 1)
      .map((row) => ({
        task: row.task,
        firstFailure: row.firstFailure,
        final: row.failure ?? "graded",
      })),
    passingOnEmptyPatch: graded.filter((row) => row.reward > 0).map((row) => row.task),
    // Pass-to-pass tests pass on the base by construction; none passing means
    // the suite never ran here, so even a correct patch would score 0.
    suiteDidNotRun: graded
      .filter((row) => (row.p2pTotal ?? 0) > 0 && row.p2pPassed === 0)
      .map((row) => row.task),
    slowUnderRosetta: sorted
      .filter((row) => row.timedOut || row.verifierSeconds > SLOW_SHARE * row.budgetSeconds)
      .map((row) => ({
        task: row.task,
        verifierSeconds: row.verifierSeconds,
        budgetSeconds: row.budgetSeconds,
      })),
    verifierSeconds: {
      total: Math.round(seconds.reduce((sum, value) => sum + value, 0)),
      median: pick(0.5),
      p90: pick(0.9),
      max: seconds.at(-1) ?? null,
    },
    rows: sorted.map(({ logsDir: _logs, at: _at, ...row }) => row),
  };
}
