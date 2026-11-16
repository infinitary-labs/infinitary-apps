/** A failed job of a batch pull request's checks, with the test files its log named as failed. */
export type FailedJob = { name: string; files: readonly string[] };
/** The test files a failed job's log names as failed, in the order it names them. */
export function failedTestFiles(log: string): string[];
/** The confirm's plan: the failed jobs' names, one a line, and the failed files, separated by spaces; null when nothing runs again. */
export function confirmPlan(failedJobs: readonly FailedJob[]): { jobs: string; files: string } | null;
/** The run's failed jobs outside the confirm, each with the test files its log names. */
export function readFailedJobs(
  /** An Octokit instance, as actions/github-script passes it. */
  github: unknown,
  repo: { owner: string; repo: string },
  run: number,
): Promise<FailedJob[]>;
/** Whether a job is one of the checks': a job of a workflow the batch's checks call. */
export function isCheckJob(job: { name: string }): boolean;
/** What one reading of the run's jobs says of the checks. */
export function checksState(
  jobs: readonly { name: string; status: string; conclusion: string | null }[],
): "failed" | "passed" | "running";
/** What is left to confirm once every check ended, beside the jobs the first confirm took. */
export function laterPlan(
  failedJobs: readonly FailedJob[],
  confirmed: readonly string[],
):
  | { left: "nothing" | "unanswerable"; jobs?: undefined; files?: undefined }
  | { left: "confirm"; jobs: string; files: string };
/** batch-checks.yml's first-failure job: writes the outputs `found`, `jobs` and `files`. */
export function firstFailure(script: {
  github: unknown;
  context: unknown;
  core: unknown;
  everySeconds?: number;
}): Promise<void>;
/** batch-checks.yml's failures job: writes the outputs `left`, `jobs` and `files`. */
export function failures(script: {
  github: unknown;
  context: unknown;
  core: unknown;
  confirmed?: string;
}): Promise<void>;
