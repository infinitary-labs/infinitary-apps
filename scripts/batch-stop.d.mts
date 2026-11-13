/** A job read only by its name and outcome, as GitHub lists a run's jobs. */
export type StopJob = { name: string; status: string; conclusion: string | null };
/** How the code checks' job name ends, at every level of a batch run's names. */
export const CODE_CHECKS: string;
/** How the watch job's own name ends. */
export const WATCH: string;
/** What one reading of the run's jobs says of the code checks. */
export function codeChecksState(jobs: readonly StopJob[]): "failed" | "passed" | "running" | "absent";
/** The watch job: writes the output `code_checks`, `failure` or `success`, once the code checks end. */
export function watch(script: {
  github: unknown;
  context: unknown;
  core: unknown;
  everySeconds?: number;
}): Promise<void>;
