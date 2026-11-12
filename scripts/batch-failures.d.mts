/** A failed job of a batch pull request's checks, with the test files its log named as failed. */
export type FailedJob = { name: string; files: readonly string[] };
/** The confirm's plan: the failed jobs' names, one a line, and the failed files, separated by spaces; null when nothing runs again. */
export function confirmPlan(failedJobs: readonly FailedJob[]): { jobs: string; files: string } | null;
/** The run's failed jobs outside the confirm, each with the test files its log names. */
export function readFailedJobs(
  /** An Octokit instance, as actions/github-script passes it. */
  github: unknown,
  repo: { owner: string; repo: string },
  run: number,
): Promise<FailedJob[]>;
/** batch-checks.yml's failures job: writes the outputs `jobs` and `files`. */
export function failures(script: { github: unknown; context: unknown; core: unknown }): Promise<void>;
