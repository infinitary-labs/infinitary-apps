/** GitHub readings consumed by batch-pull.mjs, never persisted state. */
export type BatchPull = {
  number: number;
  head: { ref?: string; sha: string; repo?: { full_name: string } | null };
  base?: { repo?: { full_name: string } | null };
};
export type BatchPullRun = {
  path: string;
  event: string;
  head_branch: string | null;
  head_repository?: { full_name: string } | null;
  repository?: { full_name: string };
};
/** A job read only by its name and outcome. */
export type BatchPullJob = { name: string; status: string; conclusion: string | null };
/** A changed file as a pull request's file list names it. */
export type ChangedFile = { filename: string; previous_filename?: string };

/** What a batch's branch starts with. */
export const BATCH_BRANCH: string;
/** The workflow a batch pull request starts, as GitHub names a run's file. */
export const BATCH_PULL_RUN: string;
/** What every job of the batch's checks starts with. */
export const BATCH_PULL_CHECKS: string;
/** What each confirm job's own name starts with, under the checks. */
export const BATCH_PULL_CONFIRM: string;
/** What each Linux test group's own confirm starts with, under the checks. */
export const BATCH_PULL_GROUP_CONFIRM: string;
/** Whether a job of the run, by its full name, is a confirm: the checks' own or a test group's. */
export function isConfirmJob(name: string): boolean;
/** Whether `pull` is a batch pull request of `repository` itself, never a fork's branch of that name. */
export function isBatchPull(pull: BatchPull, repository: string): boolean;
/** Whether `run` is a batch pull request's own run in `repository`. */
export function isBatchPullRun(run: BatchPullRun, repository: string): boolean;
/** The tree a batch pull request's run passed, from its jobs, or null when its last job did not pass. */
export function batchPullTree(jobs: readonly BatchPullJob[]): string | null;
/** The check files a batch pull request's own run reads, and the folders it names ending in a slash, from every file under .github/ (path to text). */
export function batchRunCheckFiles(checkFiles: ReadonlyMap<string, string>): Set<string>;
/** Whether a batch changed a file its own run reads; a list GitHub cut short counts as changed. */
export function changedCheckFile(
  files: readonly ChangedFile[],
  total: number,
  runCheckFiles: ReadonlySet<string>,
): boolean;
/** How main's check treats a push that merged a batch pull request. */
export function sortBatchPull(input: {
  tree: string;
  /** The pull request's runs on its version, newest first, each with its latest jobs. */
  runs: readonly { id: number; jobs: readonly BatchPullJob[] }[];
  files: readonly ChangedFile[];
  /** How many files GitHub says the pull request changed. */
  total: number;
  /** Every file under .github/ in the pushed version, path to text. */
  checkFiles: ReadonlyMap<string, string>;
}): { kind: "full" | "covered"; run?: number };
