/** Every file under .github/ in the checkout at `root`, path to text. */
export function readCheckFiles(root: string): Promise<Map<string, string>>;
/** What the job of a main run that left its push to the next batch starts with, after its trigger. */
export const LEFT_TO_NEXT_BATCH: string;
/** Whether a main run's jobs show it left its push to the next batch. */
export function leftToNextBatch(jobs: readonly { name: string }[]): boolean;
/** Whether a pull request came from another copy of the project into `repository`. */
export function isOutsidePull(
  pull: { head?: { repo?: { full_name?: string } | null }; base?: { repo?: { full_name?: string } | null } },
  repository: string,
): boolean;
/** Octokit instances, as actions/github-script passes them. */
export function readMainPush(
  github: unknown,
  repo: { owner: string; repo: string },
  push: { sha: string; tree: string; checkFiles: ReadonlyMap<string, string> },
): Promise<
  { kind: "full" } | { kind: "covered"; run: number } | { kind: "outside"; pull: number }
>;
