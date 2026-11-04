/**
 * A reviewed pull request a `request_merge` card asks the captain to
 * authorize (FI3-1543). The host stores it; the agent never supplies the
 * target on the click. Preparing one grants no approval and merges nothing.
 */

export const MERGE_REVIEW_METHODS = ["squash"] as const;
export type MergeReviewMethod = (typeof MERGE_REVIEW_METHODS)[number];

/**
 * The crew's declaration that this exact head intentionally has no checks.
 * The host checks the head and the fresh check facts; it does not judge the
 * evidence by reading it.
 */
export type AbsentChecksDeclaration = {
  headSha: string;
  /** Workflow and changed-file evidence the crew judged applicable. */
  evidence: string;
  /** The local gate the crew ran at this head, and its result. */
  localGate: string;
};

/**
 * One branch rule a merge past the rules may skip (FI3-1571 piece 2): the
 * rule in plain words and the rule set that holds it, as GitHub names it.
 */
export type SkippedRule = { ruleset: string; rule: string };

/** What a merge past the branch rules skips, as its review read it. */
export type MergeSkips = {
  rules: SkippedRule[];
  /** Checks that failed at the reviewed version, by name. */
  failedChecks: string[];
};

/**
 * Any open pull request in the task's project, whoever opened it: naming it
 * makes it one of the task's changes (INF-2490, `primitives/changes.md`).
 * A review saved before then also names whose it was; nothing reads that.
 */
export type MergeReview = {
  id: string;
  /**
   * The managed project the pull request is in when it is not the task's
   * own (INF-2510): open_change opened it there. Absent means the task's
   * own project.
   */
  repoId?: string;
  /** `github` includes GitHub Enterprise. */
  kind: "github" | "gitlab";
  host: string;
  owner: string;
  name: string;
  number: number;
  headSha: string;
  base: string;
  branch: string;
  method: MergeReviewMethod;
  title: string;
  absentChecks?: AbsentChecksDeclaration;
  /**
   * A merge past the branch rules (FI3-1571 piece 2): GitHub only, squash
   * only. The card names every rule it may skip and every failed check;
   * only the captain's click on that card sends it.
   */
  skips?: MergeSkips;
  /**
   * Set before a merge past the rules is sent, then its outcome, so a
   * second click, a restart or a revised card never sends it again.
   */
  sent?: { at: number; outcome?: "failed" | "unknown"; text?: string };
  at: number;
  /** Set once a merge of this review is confirmed, so a repeat sends nothing. */
  receipt?: { head: string; sha?: string; at: number };
};

/** How many reviews a task keeps. Older ones drop; a receipt stays findable until then. */
export const MERGE_REVIEW_CAP = 8;

/**
 * A GitHub rule type in plain words, for the rules that can hold a pull
 * request's merge; undefined for the ones that only guard creating,
 * deleting, renaming or force-pushing a branch, which a merge never meets.
 * A type the app does not know yet reads as GitHub names it.
 */
export function mergeRuleWords(type: string): string | undefined {
  if (NOT_MERGE_RULES.has(type)) return undefined;
  return MERGE_RULE_WORDS[type] ?? type.replace(/_/g, " ");
}

const NOT_MERGE_RULES = new Set([
  "creation",
  "deletion",
  "non_fast_forward",
  "branch_name_pattern",
  "tag_name_pattern",
]);

const MERGE_RULE_WORDS: Record<string, string> = {
  pull_request: "a review before merging",
  required_status_checks: "required checks",
  required_deployments: "required deployments",
  required_signatures: "signed commits",
  required_linear_history: "a straight history",
  merge_queue: "the merge queue",
  update: "who may update the branch",
  code_scanning: "code scanning results",
  code_quality: "code quality results",
  copilot_code_review: "an automatic code review",
  workflows: "required workflows",
  commit_message_pattern: "the commit message format",
  commit_author_email_pattern: "the commit email format",
  committer_email_pattern: "the commit email format",
  file_path_restriction: "file restrictions",
  max_file_path_length: "file restrictions",
  file_extension_restriction: "file restrictions",
  max_file_size: "file restrictions",
};
