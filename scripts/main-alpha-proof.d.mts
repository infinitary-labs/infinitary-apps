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
export function verifyMainEvidence(
  run: MainRun,
  jobs: readonly MainJob[],
  repository: string,
  source: string,
): { source: string; runId: number; attempt: number; url: string };
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
): { runId: number; attempt: number; url: string };
/** The alpha's proof for a completed main run: its own full check, or its covering batch's. */
export function proveMain(
  /** An Octokit instance, as actions/github-script passes it. */
  github: unknown,
  repo: { owner: string; repo: string },
  run: MainRun,
  source: string,
): Promise<{ source: string; runId: number; attempt: number; url: string }>;
