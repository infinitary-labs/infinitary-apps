import { HEARTBEAT_WAKE } from "./heartbeat";

/**
 * The wake a runbook asks for by naming it in its manifest's `wakes`
 * (docs/runbooks.md, "Built-ins"): new comments on a pull request a task
 * follows (docs/forge.md, "Comments on a pull request"). The host never
 * names the runbook that asks; a personal copy keeps the wake.
 */
export const PULL_REQUEST_COMMENTS_WAKE = "pull-request-comments";

/** Every wake a runbook may ask for: the host's closed list of what it can read. */
export const RUNBOOK_WAKES = [PULL_REQUEST_COMMENTS_WAKE, HEARTBEAT_WAKE] as const;

/**
 * Who wrote a comment, as the host reads it: the person whose sign-in the
 * app uses (`you`), someone the project names as an owner, member or
 * collaborator (`can-write`), anyone else (`cannot-write`), or an account
 * the host marks as a bot.
 */
export type CommentRelation = "you" | "can-write" | "cannot-write" | "bot";

/**
 * One new comment, as the wake names it: never its words, which the
 * crewmate reads itself as outside data. `kind` is a conversation comment,
 * a comment on a line of the change, or a review's own words.
 */
export type PullCommentFact = {
  id: number;
  kind: "comment" | "line" | "review";
  author: string;
  relation: CommentRelation;
  /** The file a line comment is on, and its line when the host gave one. */
  path?: string;
  line?: number;
  /** The line comment this one answers. */
  replyTo?: number;
};

/**
 * Where the comment reading of one pull request stands, a delivery fact:
 * the host's last-changed time it read at, and the comments already read,
 * so a restart never wakes about one twice.
 */
export type CommentCursor = {
  number: number;
  updatedAt?: string;
  seen: number[];
};
