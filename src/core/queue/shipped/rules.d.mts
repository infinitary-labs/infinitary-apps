/** A queue status as a host part reads it, newest first. */
export type QueueStatus = {
  state: string;
  description: string;
  url: string;
  createdAt: string;
};
export type QueueKind =
  | { kind: "waiting" }
  | { kind: "in-batch"; run: number }
  | { kind: "paused"; run: number }
  | { kind: "passed"; run: number; tree: string }
  | { kind: "failed" };
export type QueueState = QueueKind & {
  state: string;
  description: string;
  url: string;
  since: string;
};
export type Member = { number: number; head: string };
/** An open change: its version, the branch it targets, whether it is a declared fix, and its queue state. */
export type QueueEntry = Member & { base: string; fix?: boolean; queue: QueueState | null };
export type CurrentMember = { head: string; queue: QueueState | null; swept?: QueueState | null };
export type QueueRun = { id: number; status: string; conclusion: string | null };
export type StatusWrite = Member & { state: string; description: string; url: string };
export type FailedCheck = { name: string; url: string };
export type FailedFile = { file: string; touchedBy: number[] };
export type Pause = {
  run: number;
  description: string;
  members: Member[];
  failed: FailedCheck[];
  failedFiles: FailedFile[];
  /** Whether the batch checks ran once more to confirm the failure, and it failed again. */
  confirmed?: boolean;
};
/** A failed job of a batch run with the test files its log named. */
export type FailedJob = { name: string; files: string[] };

export const QUEUE: string;
export const WAITING: string;
export const FIX_LABEL: string;
export const PAUSE_LABEL: string;
export const CHECKS_JOB: string;
export const CONFIRM_JOB: string;
export function inBatch(run: number): string;
export function passed(run: number, tree: string): string;
export function readQueueState(statuses: readonly QueueStatus[]): QueueState | null;
export function queueKind(state: string, description: string | null | undefined): QueueKind;
export function ownsChanges(run: QueueRun | undefined): boolean;
export function formBatch(
  entries: readonly QueueEntry[],
  runs: ReadonlyMap<number, QueueRun>,
  main: string,
): { action: "none" | "wait" | "sweep"; reason: string; members: Member[]; resumes: Member[] };
export function resume(
  entries: readonly QueueEntry[],
  options: { url: string; except?: number; endedRun?: number },
): StatusWrite[];
export function sendBack(
  entry: Member & { queue?: QueueState | null },
  options: { reason: string; url: string },
): StatusWrite | null;
export function answerWords(options: {
  number?: number;
  sent?: boolean;
  queue?: QueueState | null;
  reason: string;
  resumed: number;
  endedRun?: number;
  change?: string;
}): { issue: string; log: string };
export function headList(members: readonly Member[]): string;
export function readComposition(
  output: string,
  members: readonly Member[],
): {
  base: string;
  tree: string;
  merged: Member[];
  conflictsMain: Member[];
  conflictsBatch: Member[];
};
export function conflictsWithMain(member: Member, url: string): StatusWrite;
export function confirmPlan(
  failedJobs: readonly FailedJob[],
): { jobs: string; files: string } | null;
export function verdict(input: {
  run: number;
  runUrl: string;
  result: string;
  tree: string;
  members: readonly Member[];
  current: ReadonlyMap<number, CurrentMember>;
  failed?: FailedCheck[];
  failedFiles?: FailedFile[];
  /** The confirm's result: success passes a red batch; empty or skipped when none ran. */
  confirm?: string;
}): { writes: StatusWrite[]; next: "form" | null; pause: Pause | null; summary: string };
export function pauseWrites(pause: Pause, issueUrl: string): StatusWrite[];
export function pauseIssue(pause: Pause, runUrl: string): { title: string; body: string };
export function readPauseMarker(
  body: string | null | undefined,
): { run: number; changes: number[] } | null;
export function failedTestFiles(log: string): string[];
