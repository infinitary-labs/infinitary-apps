/**
 * The verifier runner: grades a patch on one DeepSWE task with the task's
 * own verifier, exactly as the benchmark's harness does it.
 *
 * DeepSWE grades in a separate, fresh container (`environment_mode =
 * "separate"`): the task image at the base commit, the hidden `tests/`
 * mounted at `/tests`, the submitted patch at `/logs/artifacts/model.patch`.
 * `tests/test.sh` resets the files the patch touches, applies it and the
 * hidden test patch, runs the suites and writes `/logs/verifier/reward.json`.
 * An empty patch grades the pristine base state.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execIn, removeContainer, startTaskContainer } from "./containers.ts";
import { type BenchTask, benchDir } from "./pool.ts";

/** `reward.json` as the task's grader writes it. */
export type RewardJson = {
  reward: number;
  partial?: number;
  f2p?: number;
  p2p?: number;
  f2p_total?: number;
  f2p_passed?: number;
  p2p_total?: number;
  p2p_passed?: number;
  [key: string]: unknown;
};

export type VerifierResult = {
  task: string;
  /** 1 pass, 0 fail, -1 the verifier itself failed (no reward.json, or a timeout). */
  reward: number;
  /** `reward.json` verbatim, or null when the verifier wrote none. */
  scores: RewardJson | null;
  patchBytes: number;
  exitCode: number;
  timedOut: boolean;
  /** The verifier's own run, container start excluded. */
  wallSeconds: number;
  /** Host folder holding `verifier/` (reward.json, ctrf.json, run.log, test-stdout.txt) and `artifacts/model.patch`. */
  logsDir: string;
};

export async function runVerifier(
  task: BenchTask,
  patch: Buffer,
  opts: { logsDir?: string; onWait?: () => void } = {},
): Promise<VerifierResult> {
  const suffix = randomBytes(4).toString("hex");
  const logsDir =
    opts.logsDir ??
    join(
      benchDir(),
      "runs",
      "verify",
      `${task.id}-${new Date().toISOString().replace(/[:.]/g, "")}-${suffix}`,
    );
  const artifacts = join(logsDir, "artifacts");
  const verifierDir = join(logsDir, "verifier");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(verifierDir, { recursive: true });
  if (patch.length > 0) writeFileSync(join(artifacts, "model.patch"), patch);

  const name = `fmb-v-${suffix}`;
  await startTaskContainer({
    name,
    task,
    role: "verifier",
    mounts: [
      { host: join(task.dir, "tests"), container: "/tests" },
      { host: artifacts, container: "/logs/artifacts" },
      { host: verifierDir, container: "/logs/verifier" },
    ],
    onWait: opts.onWait,
  });
  const stdoutPath = join(verifierDir, "test-stdout.txt");
  writeFileSync(stdoutPath, "");
  const sink = (chunk: Buffer) => appendFileSync(stdoutPath, chunk);
  try {
    const run = await execIn({
      name,
      argv: ["bash", "/tests/test.sh"],
      workdir: "/app",
      timeoutSec: task.verifier.timeoutSec,
      stdout: sink,
      stderr: sink,
    });
    const scores = readScores(verifierDir);
    return {
      task: task.id,
      reward: run.timedOut || !scores ? -1 : scores.reward,
      scores: run.timedOut ? null : scores,
      patchBytes: patch.length,
      exitCode: run.code,
      timedOut: run.timedOut,
      wallSeconds: Math.round(run.wallSeconds * 10) / 10,
      logsDir,
    };
  } finally {
    removeContainer(name);
  }
}

function readScores(verifierDir: string): RewardJson | null {
  const json = join(verifierDir, "reward.json");
  if (existsSync(json)) return JSON.parse(readFileSync(json, "utf8")) as RewardJson;
  const txt = join(verifierDir, "reward.txt");
  if (existsSync(txt)) return { reward: Number(readFileSync(txt, "utf8").trim()) };
  return null;
}
