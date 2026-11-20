/** A job read only by its name and outcome, as GitHub lists a run's jobs. */
export type StopJob = { name: string; status: string; conclusion: string | null };
/** How the code checks' job name ends, at every level of a batch run's names. */
export const CODE_CHECKS: string;
/** How the watch job's own name ends. */
export const WATCH: string;
/** What a confirm job's name holds. */
export const CONFIRM: string;
/** What the last check job's name holds. */
export const PASSED: string;
/** What one reading of the run's jobs says of the code checks. */
export function codeChecksState(jobs: readonly StopJob[]): "failed" | "passed" | "running" | "absent";
/** What failed in the code checks, in words: each failed job's last name part and its failed steps. */
export function codeChecksFailure(
  jobs: readonly (StopJob & { steps?: readonly { name: string; conclusion: string | null }[] })[],
): string;
/** The test files a confirm's log says failed again, or none when no round failed or ran. */
export function confirmedAgain(log: string): string[];
/** The failed confirm jobs of one reading. */
export function failedConfirms<Job extends StopJob>(jobs: readonly Job[]): Job[];
/** Whether every job but the watch ended: `ended` with the last check job among them, `quiet` without it. */
export function runState(jobs: readonly StopJob[]): "running" | "quiet" | "ended";
/** The watch job: writes the output `stop`, `code-checks`, `confirm` or `none`, and `failed` on a stop. */
export function watch(script: {
  github: unknown;
  context: unknown;
  core: unknown;
  everySeconds?: number;
}): Promise<void>;
