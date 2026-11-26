import type { BatchPullRun } from "./batch-pull.mjs";

/** A job of a run's attempt as GitHub lists it, read by its id, name, outcome, runner and steps. */
export type RunJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  runner_id?: number | null;
  runner_name?: string | null;
  steps?: readonly unknown[] | null;
};
/** The batch run being judged, as a workflow_run event or GitHub's run reading gives it. */
export type JudgedRun = BatchPullRun & { id: number; head_sha: string; run_attempt?: number };
/** What to do with one attempt: rerun its failed jobs, or nothing and why (`reason`, set whenever `act` is none). */
export type Verdict = {
  act: "rerun" | "none";
  reason?: "not-batch" | "passed" | "ended" | "others" | "limit" | "moved";
  unplaced: RunJob[];
  words: string;
};

/** How GitHub's own annotation on a job no hosted runner took begins. */
export const NEVER_PLACED: string;
/** The newest attempt that may still ask for one more: a run reruns itself at most twice. */
export const LAST_ATTEMPT: number;
/** Whether GitHub's record of `job` says it never placed it on a runner, given the annotations on its check. */
export function neverPlaced(job: RunJob, messages: readonly unknown[]): boolean;
/** The run's jobs of `attempt` that neither passed nor skipped, split into those GitHub never placed and the rest. */
export function unplacedJobs(read: {
  github: unknown;
  owner: string;
  repo: string;
  runId: number;
  attempt: number;
}): Promise<{ unplaced: RunJob[]; others: RunJob[] }>;
/** What to do with one attempt of a run that ended. */
export function judge(read: {
  github: unknown;
  owner: string;
  repo: string;
  run: JudgedRun;
  attempt: number;
}): Promise<Verdict>;
/** The workflow's step; a run id given by hand makes it a dry run that reruns nothing. */
export function rerunUnplaced(script: {
  github: unknown;
  context: unknown;
  core: {
    info(text: string): void;
    notice(text: string): void;
    summary: { addRaw(text: string): { write(): Promise<unknown> } };
  };
  runId?: string;
  attempt?: string;
}): Promise<Verdict>;
