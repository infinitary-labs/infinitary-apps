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
/** What a rule found: the kind of stop, what failed in words, and the notice it writes. */
export type Stop = { kind: string; failed: string; notice: string };
/** A watch's rule: when it stops, when the run ended, and what it says when nothing stopped. */
export type StopRule = {
  stop(jobs: readonly (StopJob & { id?: number; completed_at?: string | null })[], read: unknown): Promise<Stop | null>;
  state(jobs: readonly StopJob[]): "running" | "quiet" | "ended";
  none: string;
};
/** The merge batch's rule: failed code checks, or a confirm that failed again. */
export const batch: StopRule;
/** What a cut's stop job's name holds. */
export const STOP_CUT: string;
/** How a cut's upload job's name ends, a publishing run's and a rehearsal's. */
export const UPLOAD: readonly string[];
/** The cut's failed jobs in one reading, the first to end first, by their last name part. */
export function cutFailures(jobs: readonly (StopJob & { completed_at?: string | null })[]): string[];
/** Whether every job of a cut before its upload ended: `ended` once the upload is listed. */
export function cutState(jobs: readonly StopJob[]): "running" | "quiet" | "ended";
/** An alpha cut's rule, a rehearsal's too: the first job that failed or timed out. */
export const cut: StopRule;
/** The watch job: writes the output `stop`, the rule's kind of stop or `none`, and `failed` on a stop. */
export function watch(script: {
  github: unknown;
  context: unknown;
  core: unknown;
  everySeconds?: number;
  rule?: StopRule;
}): Promise<void>;
