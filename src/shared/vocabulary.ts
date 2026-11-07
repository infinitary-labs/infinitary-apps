import type { RepoDelivery } from "./repos";
import type { Rigor } from "./rigor";
import type { RunChecks, TaskDeliveryView } from "./tasks";

/**
 * The words the app says for the facts it stores (roadmap 1.5, the
 * plain-language pass; the design skill's `copy/Vocabulary.prompt.md` is
 * the one home of the rule and the table). A stored value is a posture, a
 * rigor, a checks state; what a person reads is where a change goes, how
 * carefully it was done, whether the checks passed. Shared maps keep the
 * words consistent, with compact project labels distinct from delivery prose.
 */

/**
 * A word for each state a map knows, typed by those states so a reader
 * naming one gets a string, while a stored value read as a plain string
 * still indexes it (an unknown one reads undefined).
 */
type Words<State extends string> = Readonly<Record<State, string>> &
  Readonly<Partial<Record<string, string>>>;

/** Where a finished change goes, by delivery posture. */
export const DELIVERY_WORDS: Record<string, string> = {
  "direct-pr": "pull request",
  "queue-pr": "batched pull request",
  "local-only": "merged locally",
  "in-place": "built in place",
};

/** Compact delivery labels for project badges and policy choices, not task prose. */
export const PROJECT_DELIVERY_WORDS: Words<RepoDelivery> = {
  "direct-pr": "pull requests",
  "queue-pr": "batched pull requests",
  "local-only": "local merge",
};

/** What happens before a project's finished changes go in. */
export const AUTONOMY_WORDS = {
  putsInItself: "Merges on its own",
  asksFirst: "Asks first",
} as const;

/** The switch asks before merging; checked means the person is asked first. */
export const AUTONOMY_SWITCH_NAME = "Ask before merging";

/**
 * The host's merge button on a completion card, and the way out that
 * merges, by how the change goes in: its pull request merged where the
 * project lives, or its branch merged here.
 */
export const MERGE_WORDS = {
  "merge-pr": "Merge the pull request",
  land: "Merge the branch",
} as const;

/** The button the app puts beside a merge that keeps the task, in place of Discard (INF-2744). */
export const MERGE_NOT_NOW_WORDS = "Not now";

/**
 * The button beside Merge on a Quick or Default pull request's merge card
 * (INF-562, the captain's own words for it): the click makes the task
 * Careful, so its built work is reviewed before a new merge card comes back.
 */
export const REVIEW_CAREFULLY_WORDS = "Review carefully";

/**
 * The merge button while checks have not passed (captain INF-1555 F12).
 * The click keeps the captain's approval; the app merges when the checks pass.
 */
export const MERGE_WHEN_CHECKS_PASS_WORDS = "Merge when checks pass";

/**
 * The same button once the checks have failed (the captain's words on
 * INF-23): the click keeps his approval for a fix, which brings a new
 * version with fresh checks.
 */
export const MERGE_AFTER_FIXING_WORDS = "Merge after fixing errors";

/**
 * The button beside it on failed checks (INF-1137 friction 6): the click is
 * the captain's own word that the failed checks do not hold this version,
 * so the app merges it now.
 */
export const MERGE_ANYWAY_WORDS = "Merge anyway";

/** The host's button on a card that merges past the branch rules (FI3-1571 piece 2). */
export const SKIP_RULES_MERGE_WORDS = "Merge, skipping the rules";

/** The host's button on a card that asks to send a write (FI3-1571 piece 4), naming where it goes. */
export function sendWriteWords(place: string): string {
  return `Send it to ${place}`;
}

/** How carefully the work was done, by rigor tier. */
export const CARE_WORDS: Words<Rigor> = {
  quick: "Quick",
  standard: "Default",
  reviewed: "Careful",
};

/** The project a fact names for a task that sits in no project. */
export const DEFAULT_WORKSPACE_WORD = "Default workspace";

/** What the checks on a proposed change say, by CI state. */
export const CHECK_WORDS: Words<NonNullable<TaskDeliveryView["ci"]>> = {
  green: "passed",
  red: "failed",
  pending: "running",
  "no-pr": "no pull request yet",
  merged: "merged outside the app",
};

/** What the checks say of a run started by hand, by its state (INF-594). */
export const RUN_CHECK_WORDS: Words<RunChecks["state"]> = {
  running: CHECK_WORDS.pending,
  passed: CHECK_WORDS.green,
  failed: CHECK_WORDS.red,
  cancelled: "cancelled",
};

/** What the checks say of a change no reading has reached yet. */
export const CHECKS_NOT_READ_WORDS = "not read yet";

/**
 * The task record's Pull requests row (INF-2490): one line per pull request
 * on a task with more than one, its state and the one whose merge closes it.
 */
export const PULL_REQUEST_WORDS = {
  label: "Pull requests",
  merged: "merged",
  checks: "checks",
  closes: "merging it closes the task",
} as const;

/**
 * What a change adds and deletes, as the fact strip's Lines cell says it
 * (INF-820): the plus and the minus sign beside separate words, so neither
 * count reads as the other.
 */
export function changeLinesWords(added: number, deleted: number): string {
  return `+${added.toLocaleString("en-US")} added · −${deleted.toLocaleString("en-US")} deleted`;
}

/** An independent review's verdict, as a fact strip says it. */
export const REVIEW_WORDS: Words<"pass" | "findings" | "blocked"> = {
  pass: "passed",
  findings: "findings",
  blocked: "blocked",
};

/** The model tier's word in a feed line, when a line must name one. */
export const TIER_WORDS: Record<string, string> = {
  premium: "premium",
  high: "high",
  medium: "medium",
  low: "low",
};

/**
 * What a plugin can read, in the person's words (the consent card, one
 * plugin vehicle Phase A; the design skill's vocabulary table): the app's
 * own reads a panel may declare, by catalog name.
 */
export const READ_WORDS: Record<string, string> = {
  "quota.snapshot": "your plans' allowance",
  "tasks.board": "your tasks",
  "tasks.detail": "each task in full, with your words and its reports",
  "tasks.search": "your closed tasks, found by a key or title",
  "feed.recent": "the activity feed",
  "forge.changes": "your pull requests",
  "automation.list": "your automations and when they run",
  "knowledge.collections": "what your crew learned, counted by collection",
  "knowledge.graph": "how the ideas your crew learned connect",
  "knowledge.concepts": "the ideas your crew learned",
  "knowledge.findings": "what your crew found, with how well it was checked",
  "knowledge.entry": "each idea and finding in full, with its evidence",
  "knowledge.directions": "your standing directions",
  "knowledge.direction": "a standing direction and its edit history",
};

/**
 * The views of the app's record a plugin may query, by the name before the
 * version (`v_usage` for `v_usage_v1`), so a later `_v2` still reads.
 */
export const VIEW_WORDS: Record<string, string> = {
  v_version: "which version of the app's data this is",
  v_tasks: "your tasks",
  v_task_events: "what happened on each task",
  v_usage: "the tokens each task used",
  v_feed: "the activity feed",
  v_quota_windows: "your plans' allowance",
  v_routing: "which model each task ran on",
  v_projects: "your projects",
  v_repos: "how each of your projects is set up",
};

/** A view's words, by its versioned name. */
export function viewWords(view: string): string {
  return VIEW_WORDS[view.replace(/_v[0-9]+$/, "")] ?? view;
}
