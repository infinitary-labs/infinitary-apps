/** GitHub readings consumed by batch.mjs, never persisted state. */
export type CommitStatus = {
  state: string;
  description: string | null;
  context: string;
  target_url: string | null;
  created_at: string;
};
export type QueueState = {
  state: string;
  description: string;
  url: string;
  since: string;
  kind: "waiting" | "in-batch" | "paused" | "passed" | "failed";
  run?: number;
  tree?: string;
};
/** An open pull request: its version and its queue state. */
export type QueueEntry = { number: number; head: string; queue: QueueState | null };

export function readQueueStatus(statuses: readonly CommitStatus[]): QueueState | null;
export function sortMainPush(input: {
  tree: string;
  queue: QueueState | null;
  open: readonly QueueEntry[];
}): { kind: "full" | "covered" | "landing"; run?: number };
/** Octokit instances, as actions/github-script passes them. */
export function readMainPush(
  github: unknown,
  repo: { owner: string; repo: string },
  push: { sha: string; tree: string },
): Promise<{ kind: "full" | "covered" | "landing"; run?: number }>;
