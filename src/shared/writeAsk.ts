/**
 * A write a crewmate asked to send where a project lives, kept on its task
 * until the captain's click sends it (FI3-1571 piece 4, `docs/forge.md`,
 * "A write that asks"): one outside the task's own project, any write of a
 * task that only answers but a run start or rerun on its own project, and
 * any write through the github.com sign-in.
 * The host stores the exact call; the card names it by `id` and never
 * carries the call itself, so only what was stored is ever sent.
 */
export type WriteAsk = {
  id: string;
  /** The host's kind: GitHub, including Enterprise, or GitLab. */
  kind: "github" | "gitlab";
  /** The host's address: `github.com`, a GitHub Enterprise or GitLab server's own. */
  host: string;
  /** The host in a sentence: "GitHub", "GitLab", or a server's own address. */
  place: string;
  /** Whose sign-in sends it: the project's own host, or the github.com sign-in. */
  via: "project" | "account";
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  /** The relative path as the host's policy spelled it, with its query. */
  path: string;
  /** The request's JSON text, as the crewmate gave it. */
  body?: string;
  /** A release file in the working copy, relative to it. The bytes are read when the click sends it. */
  file?: string;
  validationEffect?: string;
  at: number;
  /** When the captain's click took it, set before it was sent: it is never sent again. */
  sentAt?: number;
  /** What came of the click: the host's answer, an outcome nobody knows, or nothing sent. */
  outcome?: WriteAskOutcome;
};

export type WriteAskOutcome =
  | { kind: "answered"; status: number; requestId: string | null }
  | { kind: "unknown"; why: string }
  | { kind: "refused"; why: string };

/** How many asks a task keeps, newest first; an older one drops, sent or not. */
export const WRITE_ASK_CAP = 8;

/** What a refusal says about a send the captain's click already took: it is never sent again. */
export const NEVER_SENT_AGAIN = "never sent again";
