/** A failed job of a batch pull request's checks, with the test files its log named as failed. */
export type FailedJob = { name: string; files: readonly string[] };
/** The test files a failed job's log names as failed, in the order it names them. */
export function failedTestFiles(log: string): string[];
/** The confirm's plan: the failed jobs' names, one a line, and the failed files, separated by spaces; null when nothing runs again. */
export function confirmPlan(failedJobs: readonly FailedJob[]): { jobs: string; files: string } | null;
/** The run's failed jobs outside the confirms, each with the test files its log names; `only` picks the jobs read. */
export function readFailedJobs(
  /** An Octokit instance, as actions/github-script passes it. */
  github: unknown,
  repo: { owner: string; repo: string },
  run: number,
  only?: (job: { name: string }) => boolean,
): Promise<FailedJob[]>;
/** Whether a job is one of the checks': a job of a workflow the batch's checks call. */
export function isCheckJob(job: { name: string }): boolean;
/** What is left to confirm once every check ended, beside the jobs the test groups' confirms took. */
export function laterPlan(
  failedJobs: readonly FailedJob[],
  confirmed: readonly string[],
):
  | { left: "nothing" | "unanswerable"; jobs?: undefined; files?: undefined }
  | { left: "confirm"; jobs: string; files: string };
/** What the test groups' own confirms answered: the failed jobs they took, and whether every one that ran passed. */
export function groupConfirms(
  failedJobs: readonly FailedJob[],
  jobs: readonly { name: string; status: string; conclusion: string | null }[],
): { confirmed: string[]; grouped: "passed" | "failed" };
/** verify.yml's linux-tests-confirm: writes the outputs `found` and `files` for one test group. */
export function groupFailure(script: {
  github: unknown;
  context: unknown;
  core: unknown;
  group: string;
}): Promise<void>;
/** batch-checks.yml's failures job: writes the outputs `left`, `jobs`, `files` and `grouped`. */
export function failures(script: { github: unknown; context: unknown; core: unknown }): Promise<void>;
