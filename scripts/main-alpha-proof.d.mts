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
/** The job-name prefix of main.yml's phone call, which the alpha proof never reads. */
export const PHONE_PREFIX: string;
