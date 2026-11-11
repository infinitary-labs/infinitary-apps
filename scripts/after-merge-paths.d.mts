export const PATH_READING_STEP: string;
export type AfterMergeWorkflow = "main" | "prompt-budget" | "republish-casks";

export function relevantFiles(workflow: AfterMergeWorkflow, files: readonly string[]): boolean;

export function afterMergeShouldRun(
  github: {
    rest: {
      actions: {
        listWorkflowRuns(input: { owner: string; repo: string; workflow_id: string; branch: string; status: string; per_page: number }): Promise<{ data: { workflow_runs?: { id: number; status: string; conclusion: string; head_sha: string }[] } }>;
        listJobsForWorkflowRun(input: { owner: string; repo: string; run_id: number; filter: string; per_page: number }): Promise<{ data: { jobs?: { steps?: { name: string; conclusion: string }[] }[] } }>;
      };
      repos: {
        compareCommits(input: {
          owner: string;
          repo: string;
          base: string;
          head: string;
          per_page: number;
        }): Promise<{
          data: {
            status?: string;
            files?: { filename: string; previous_filename?: string }[];
          };
        }>;
      };
    };
  },
  context: {
    eventName: string;
    repo: { owner: string; repo: string };
    sha: string;
    runId: number;
    payload: { client_payload?: { base?: string } };
  },
  workflow: AfterMergeWorkflow,
): Promise<boolean>;
