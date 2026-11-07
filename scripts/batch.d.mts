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
  kind: "waiting" | "in-batch" | "passed" | "failed";
  run?: number;
  tree?: string;
};
export type Member = { number: number; head: string };
export type QueueEntry = Member & { queue: QueueState | null };
export type BatchJob = { name: string; status: string; conclusion: string | null };
/** A run batch.yml started by dispatch, as GitHub lists them. */
export type DispatchedRun = {
  id: number;
  run_number: number;
  display_title: string;
  status: string;
  conclusion: string | null;
};
export type BatchRun = {
  id: number;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at?: string;
  /** The first attempt's verdict job, read only when that attempt failed. */
  verdict?: BatchJob | null;
  /** The newest run asking for this run's rerun, read only when that verdict passed. */
  rerun?: DispatchedRun | null;
};
export type StatusWrite = Member & { state: string; description: string; url: string };

export const QUEUE: string;
export const WAITING: string;
export function inBatch(runId: number): string;
export function passed(runId: number, tree: string, rerun?: boolean): string;
export function rerunOf(runId: number): string;
export function readQueueStatus(statuses: readonly CommitStatus[]): QueueState | null;
export function ownsChanges(run: BatchRun | undefined): boolean;
export function formBatch(
  entries: readonly QueueEntry[],
  runs: ReadonlyMap<number, BatchRun>,
): { action: "none" | "wait" | "sweep"; reason: string; members: Member[] };
export function headList(members: readonly Member[]): string;
export function readComposition(
  output: string,
  members: readonly Member[],
): { tree: string; merged: Member[]; conflictsMain: Member[]; conflictsBatch: Member[] };
export function verdict(input: {
  runId: number;
  runUrl: string;
  attempt: number;
  swept: string;
  tree: string;
  members: readonly Member[];
  current: ReadonlyMap<number, { head: string; queue: QueueState | null }>;
  failedJob?: { name: string; html_url: string };
}): { writes: StatusWrite[]; next: "rerun" | "sweep" | null; summary: string };
export function sortMainPush(input: {
  tree: string;
  queue: QueueState | null;
  open: readonly QueueEntry[];
}): { kind: "full" | "covered" | "landing"; run?: number };
/** Octokit instances, as actions/github-script passes them. */
export function readOpenQueue(github: unknown, repo: { owner: string; repo: string }): Promise<QueueEntry[]>;
export function readRuns(
  github: unknown,
  repo: { owner: string; repo: string },
  entries: readonly QueueEntry[],
): Promise<Map<number, BatchRun>>;
export function writeStatus(github: unknown, repo: { owner: string; repo: string }, write: StatusWrite): Promise<unknown>;
export function readMainPush(
  github: unknown,
  repo: { owner: string; repo: string },
  push: { sha: string; tree: string },
): Promise<{ kind: "full" | "covered" | "landing"; run?: number }>;
