import type { Member, QueueEntry } from "./rules.mjs";

/** GitLab's REST API as the queue reaches it; tests pass a stand-in, and Infinitary passes the person's own sign-in. */
export type GitLabQueueApi = {
  // biome-ignore lint/suspicious/noExplicitAny: GitLab's JSON answers, read field by field
  get(path: string): Promise<any>;
  text(path: string): Promise<string>;
  // biome-ignore lint/suspicious/noExplicitAny: GitLab's JSON answers, read field by field
  send(method: string, path: string, body?: unknown): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: GitLab's JSON answers, read field by field
  list(path: string): Promise<any[]>;
};

/** The queue's pipeline as the queue's jobs see it: the project, its default branch and this pipeline. */
export type GitLabQueueEnv = {
  /** The project's id or its URL-encoded path. */
  project: string | number;
  defaultBranch: string;
  pipelineId: number;
  pipelineUrl: string;
};

export type GitLabQueueArgs = {
  api: GitLabQueueApi;
  env: GitLabQueueEnv;
  log(text: string): void;
};

export const CHECKS_JOB: string;
export const TOKEN_VARIABLE: string;
export const QUEUE_ENVIRONMENT: string;
/** A held change's waiting words: it waits for a Maintainer to approve its version after its last push. */
export const HELD: string;
export const BATCH_PIPELINE_FILE: string;
export const OUTPUT_FILE: string;
export function named(text: string): string;
export function gitlabState(state: string): string;
export function rulesState(status: string): string;
export function readHeads(heads: string | undefined): Member[];
export function batchPipeline(args: { heads: string; base: string; tree: string }): string;
export function noBatchPipeline(reason: string): string;
export function readOpenQueue(api: GitLabQueueApi, env: GitLabQueueEnv): Promise<QueueEntry[]>;
export function startForm(api: GitLabQueueApi, env: GitLabQueueEnv): Promise<unknown>;
export function form(
  args: GitLabQueueArgs & { compose(members: Member[]): string | Promise<string> },
): Promise<{ run: boolean; reason: string; members: Member[]; tree: string }>;
export function decide(
  args: GitLabQueueArgs & { members: Member[]; tree: string },
): Promise<{ summary: string; next: string | null }>;
export function answer(
  args: GitLabQueueArgs & { action: string; number?: string | number; reason: string },
): Promise<void>;
export function gitlabApi(args: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}): GitLabQueueApi;
export function run(command: string, vars?: Record<string, string | undefined>): Promise<void>;
