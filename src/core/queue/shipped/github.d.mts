import type { Member, QueueEntry } from "./rules.mjs";

/** The part of actions/github-script's arguments the queue uses; tests pass a stand-in of GitHub's client. */
export type ScriptArgs = {
  // biome-ignore lint/suspicious/noExplicitAny: github-script's Octokit client, read through its REST methods
  github: any;
  context: {
    repo: { owner: string; repo: string };
    runId: number;
    serverUrl: string;
    payload: { repository?: { default_branch?: string } };
  };
  core: {
    notice(text: string): void;
    setOutput(name: string, value: string): void;
    summary: { addHeading(text: string): { addRaw(text: string): { write(): Promise<unknown> } } };
  };
};

export const WORKFLOW: string;
export function readOpenQueue(
  // biome-ignore lint/suspicious/noExplicitAny: github-script's Octokit client
  github: any,
  repo: ScriptArgs["context"]["repo"],
): Promise<QueueEntry[]>;
export function form(args: ScriptArgs): Promise<void>;
export function mark(args: ScriptArgs & { output: string; members: Member[] }): Promise<void>;
export function failures(args: ScriptArgs): Promise<void>;
export function decide(
  args: ScriptArgs & { result: string; members: Member[]; tree: string; confirm?: string },
): Promise<void>;
export function answer(
  args: ScriptArgs & { action: string; number?: string; reason: string },
): Promise<void>;
