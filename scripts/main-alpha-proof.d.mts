/** GitHub run/job facts consumed by main-alpha-proof.mjs, not persisted state. */
export type MainRun = {
  id: number;
  run_attempt: number;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  head_repository?: { full_name: string };
  repository?: { full_name: string };
  html_url: string;
};
export type MainJob = {
  name: string;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
};
/** A job read only by its name and outcome. */
export type NamedJob = Pick<MainJob, "name" | "status" | "conclusion">;
/** Every Linux journey shard of verify.yml, called as job `prefix` (default `verify / `), passed. */
export function everyLinuxJourney(jobs: readonly NamedJob[], prefix?: string): boolean;
/** verify.yml's Linux checks, called as job `prefix` (default `verify / `), passed: the code checks and build and every test group's complete set, or one `linux-checks` job from before INF-2646. */
export function linuxChecksPassed(jobs: readonly NamedJob[], prefix?: string): boolean;
/** What an alpha reuses: the checks passed, and whether the same run also ran every Linux journey. */
export type MainProof = { source: string; runId: number; attempt: number; url: string; journeys: boolean };
export function verifyMainEvidence(
  run: MainRun,
  jobs: readonly MainJob[],
  repository: string,
  source: string,
): MainProof;
/** The batch run a covered main run names in its job list, or null for a full check. */
export function coveringBatch(jobs: readonly MainJob[]): number | null;
/** Checks a covered main run and returns the batch run it names. */
export function verifyCoveredMain(
  run: MainRun,
  jobs: readonly MainJob[],
  repository: string,
  source: string,
): number;
/** Checks that a batch run's full check passed on exactly `tree`. */
export function verifyBatchEvidence(
  run: MainRun,
  jobs: readonly MainJob[],
  repository: string,
  tree: string,
): { runId: number; attempt: number; url: string; journeys: boolean };
/** The alpha's proof for a completed main run: its own full check, or its covering batch's. */
export function proveMain(
  /** An Octokit instance, as actions/github-script passes it. */
  github: unknown,
  repo: { owner: string; repo: string },
  run: MainRun,
  source: string,
): Promise<MainProof>;
export function alphaVerification(jobs: readonly NamedJob[]): "all" | "journeys" | "none" | null;
