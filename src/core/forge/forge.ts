import type { ForgeKind } from "@shared/forge";
import type { ForgeProject } from "@shared/forges";
import type { ForgeApi } from "./api";
import type { ForgeAttachments } from "./attachments";
import type { ForgeWorkflows } from "./workflows";

/**
 * The forge seam (git integration PR 1.1, `docs/forge.md`): what the app
 * asks of the place a project lives - list the person's projects there,
 * read its default branch, open a proposed change, find the open one for a
 * branch, read its checks, put it in, close it, and name it - without the
 * rest of the core knowing which host answers. One `Forge` per repository;
 * `forgeFor` in `./index.ts` picks the implementation from the repository's
 * kind. The provider files live under `./providers/` and are fenced: only
 * this directory and the composition root (`src/core/services.ts`) may
 * import one.
 *
 * The kinds answer:
 * - `github`: a pull request, its check runs and commit statuses, a merge at
 *   the checked head, over GitHub's REST API with the app's own GitHub
 *   sign-in (PR 1.2, `./signIns.ts`).
 * - `gitlab`: a merge request, the pipelines and jobs GitLab ran for its
 *   head, a squash merge at the checked head, over GitLab's REST API with
 *   the key the person made there.
 * - `git` (and Bitbucket, until its own file exists): the
 *   working copy is SENT UP as its own branch; it has no checks, so it reads
 *   green with zero of them; putting it in fast-forwards the default branch
 *   onto the checked head and sends that up.
 * - `none`: nothing leaves this Mac. Putting work in is the local land that
 *   already exists (`WorkspaceService.landTaskWork`, reached through the
 *   local-only posture); this forge answers that there is nowhere to send a
 *   change.
 */

/** Where a repository lives, as the seam needs it: its kind, host and working folder. */
export type ForgeLocation = {
  kind: ForgeKind;
  /** Lower-case host name; null for a project on this Mac or a remote on its disk. */
  host: string | null;
  owner?: string;
  name?: string;
  /** The repository's working folder on this Mac: where git runs for it. */
  dir: string;
};

/** One proposed change where the project lives. */
export type ForgeChange = {
  /** The host's own number for it (`#N` on GitHub, `!N` on GitLab); absent for a sent-up working copy. */
  number?: number;
  /** Where the person can open it; null where the host has no page for it. */
  url: string | null;
  /** The branch the change carries. */
  branch: string;
  /** The version the host holds for that branch now. */
  headSha: string;
  /** Host title; required on a pull or merge request, absent for plain Git branches. */
  title?: string;
  /** A prerequisite publication remains a draft until final proof is reviewed. */
  draft?: boolean;
  /** Host body, retained for legacy delivery and breaking-change footers. */
  body?: string;
  /** Plain text from the verified saved story, never its rendered description. */
  squashMessage?: string;
};

/**
 * One check's state, normalised: `success` and `skipped` permit green; terminal
 * failures are red; `neutral` completes without permitting green
 * and so blocks green without being red; anything
 * still queued or running is `pending`.
 */
export type ForgeCheckState =
  | "success"
  | "failure"
  | "error"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "startup_failure"
  | "stale"
  | "skipped"
  | "neutral"
  | "pending";

/**
 * One check, with when the host says it started and finished (epoch ms),
 * where it says so: the checks cell counts from them (INF-587).
 */
export type ForgeCheck = {
  name: string;
  state: ForgeCheckState;
  startedAt?: number;
  finishedAt?: number;
};

/** A check's start and finish from the host's ISO times, leaving out any it lacks or garbles. */
export function checkTimes(
  started: string | null | undefined,
  finished: string | null | undefined,
): { startedAt?: number; finishedAt?: number } {
  const startedAt = started ? Date.parse(started) : Number.NaN;
  const finishedAt = finished ? Date.parse(finished) : Number.NaN;
  return {
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(Number.isFinite(finishedAt) ? { finishedAt } : {}),
  };
}

export type ForgeOverall = "green" | "red" | "pending";

export type ForgeChecks = {
  overall: ForgeOverall;
  items: ForgeCheck[];
  /**
   * The list was empty and the host added its own "checks have not started
   * yet" marker, not a real check. A head-bound absence declaration may
   * waive only this marker.
   */
  notStarted?: boolean;
};

/**
 * Whether the host would let a change merge now, in typed terms (GitHub's
 * `mergeable_state`, GitLab's `detailed_merge_status`): `clean` may merge; `conflict` is in conflict with
 * newer work; `behind` must be brought up to date first; `blocked` is held
 * by the branch's rules - a required review, a required check, another
 * protection; `computing` is the host still working it out; `draft` is a
 * draft. Anything the app cannot place reads `computing`, never `clean`.
 */
export type ForgeReadiness = "clean" | "conflict" | "behind" | "blocked" | "computing" | "draft";

/** One pull request (a merge request on GitLab) read by its number, whatever its state (FI3-304). */
export type ForgePull = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  /** The merge commit, once merged. */
  mergedSha?: string;
  headSha: string;
  /** The branch it merges into. */
  base: string;
  /** The branch it carries, when the host named one. */
  branch?: string;
  title?: string;
  /**
   * The repository the head commit belongs to (`owner/name`). Absent when
   * the host did not say, which a referenced merge treats as unproven.
   */
  headRepo?: string;
  readiness: ForgeReadiness;
};

/**
 * Whether the signed-in person may skip a rule set, as GitHub says it
 * (`current_user_can_bypass`); null when GitHub did not say.
 */
export type ForgeBypass = "always" | "pull_requests_only" | "exempt" | "never" | null;

/** One active rule set holding a branch, read for this sign-in (FI3-1571 piece 2). */
export type ForgeRuleset = {
  id: number;
  name: string;
  bypass: ForgeBypass;
  /** The rule types it holds the branch to, in GitHub's names: `pull_request`, `required_status_checks`. */
  rules: string[];
  /** The merge methods its pull request rule allows, when it names any. */
  mergeMethods?: string[];
};

/**
 * A merge past the rules as the host reports it: merged, failed (nothing
 * merged), or not finished when the app stopped reading - an outcome the
 * app does not know and never sends again.
 */
export type ForgeSkipMerge =
  | { status: "merged"; sha?: string }
  | { status: "failed"; message: string }
  | { status: "unknown"; message: string };

/** A project the person has where it lives, newest first. */
export type { ForgeProject } from "@shared/forges";

/**
 * Why a forge call failed, as a typed fact rather than words to match:
 * `transient` is a network or host hiccup worth a quiet retry; `sign-in` is
 * the host refusing who the app is (a 401); `permission` is the host
 * refusing what was asked (a 403); `not-found` and `refused` are the host's
 * verdict on the thing itself (a stale head, a change that cannot go in);
 * `unsupported` is a kind that has no such thing.
 */
export type ForgeFailure =
  | "transient"
  | "sign-in"
  | "permission"
  | "not-found"
  | "refused"
  | "unsupported";

export class ForgeError extends Error {
  constructor(
    readonly failure: ForgeFailure,
    message: string,
    /** True when nothing was sent: the ask records refused, not unknown. */
    readonly beforeSend = false,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

/** A write's owner distinguishes a definite refusal from a response lost after sending. */
export class ForgeWriteError extends ForgeError {
  constructor(
    readonly outcome: "failed" | "uncertain",
    failure: ForgeFailure,
    message: string,
  ) {
    super(failure, message);
    this.name = "ForgeWriteError";
  }
}

/** A change's own title, without the `Draft: ` marker GitLab keeps in a draft's title. */
export function changeTitle(kind: ForgeKind, change: ForgeChange): string | undefined {
  return kind === "gitlab" && change.draft ? change.title?.replace(/^Draft: /, "") : change.title;
}

/** The host refused who the app is: no sign-in, or one it no longer accepts. */
export function isSignInForgeFailure(caught: unknown): boolean {
  return caught instanceof ForgeError && caught.failure === "sign-in";
}

/** A failure the caller may retry quietly: only a typed transient one. */
export function isTransientForgeFailure(caught: unknown): boolean {
  return caught instanceof ForgeError && caught.failure === "transient";
}

export interface Forge {
  readonly kind: ForgeKind;
  readonly host: string | null;
  /** The person's word for where the project lives ("GitHub", a host's address), or null. */
  readonly place: string | null;
  /**
   * Whether the host runs checks on a change that the app can read, and so
   * watch (`docs/forge.md`, "The check watch"). A kind without them reads
   * green with zero checks; the app watches nothing there and says so.
   */
  readonly hasChecks: boolean;
  /** Optional read-only workflow evidence; absent on hosts without a reader. */
  readonly workflows?: ForgeWorkflows;
  /** Native evidence attachments, offered only on hosts qualified for publication. */
  readonly attachments?: ForgeAttachments;
  /** Optional project-scoped JSON gateway; absent on hosts without a REST API. */
  readonly api?: ForgeApi;
  /** The person's projects on this host, newest first. */
  listProjects(): Promise<ForgeProject[]>;
  /** Every project the sign-in lists, and whether that was all; absent where the host pages none. */
  listProjectsPaged?(): Promise<{ projects: ForgeProject[]; complete: boolean }>;
  /** One project by its exact owner/name, or null; absent where the host cannot look one up. */
  findProject?(fullName: string): Promise<ForgeProject | null>;
  defaultBranch(): Promise<string>;
  /** Offer the branch as a proposed change; on a plain host this sends it up. */
  openChange(input: {
    branch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<ForgeChange>;
  /**
   * Replace the description, a saved story or legacy words, only if its just-read body and code
   * version still match. A `title` goes in the same write, only if the just-read title still
   * matches too; it is the change's own title, and GitLab keeps a draft's marker before it.
   */
  updateChangeBody?(change: ForgeChange, body: string, title?: string): Promise<void>;
  /** Read the pushed branch before opening a story-bound change. */
  branchHead?(branch: string): Promise<string>;
  /**
   * The default branch's own checks, and the commit they were read on
   * (INF-833 Fix 4). Absent where the host cannot read a branch's checks
   * apart from a proposed change; the close of the named task remains the
   * resume there.
   */
  branchChecks?(): Promise<{ sha: string; checks: ForgeChecks }>;
  /** The open proposed change for a branch, or null when there is none. */
  changeFor(branch: string): Promise<ForgeChange | null>;
  /** Host-owned readiness transition for this version, never the public write gateway. */
  markReady?(change: ForgeChange, beforeSend: () => void): Promise<ForgeChange>;
  /**
   * The checks on `change.headSha`: the change's head version, read by the one
   * green rule, or an earlier version of it an open repair was declared at (INF-685).
   */
  checks(change: ForgeChange): Promise<ForgeChecks>;
  /**
   * Put the change in, only while its head is still `headSha`. A host that
   * confirms the merge answers its commit; one that cannot says nothing.
   */
  putIn(change: ForgeChange, headSha: string): Promise<{ sha?: string } | undefined>;
  /**
   * The pull request by its number, open or not, with whether it may merge
   * now: the pinned read a kept merge approval runs on. Absent on a kind
   * with no pull requests.
   */
  pull?(number: number): Promise<ForgePull>;
  /**
   * The active rule sets that hold `branch`, each with whether this sign-in
   * may skip it. GitHub only (FI3-1571 piece 2); absent elsewhere.
   */
  branchRules?(branch: string): Promise<ForgeRuleset[]>;
  /**
   * Merge the change with squash past the rules this sign-in may skip, only
   * while its head is still `headSha`, and read the result. Sent once and
   * never retried; only the captain's click on its card calls it.
   */
  putInSkippingRules?(change: ForgeChange, headSha: string): Promise<ForgeSkipMerge>;
  /** Close the change without putting it in. */
  close(change: ForgeChange): Promise<void>;
  /** How the change is named on a surface: `#N`, `!N`, or the branch where it has no number. */
  label(change: ForgeChange): string;
  url(change: ForgeChange): string | null;
}

const RED_STATES = new Set<ForgeCheckState>([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/**
 * The standing green rule, the one home for every kind: green only
 * when EVERY check completed successfully or was skipped; terminal failures are red;
 * anything else - queued, running, neutral - blocks green without
 * being red. Zero checks reads green here: a project with no checks must still
 * be able to put work in, and the result text says so. A forge that knows
 * checks are coming but have not started (GitHub: `githubForge.ts`) reports
 * a pending item instead of an empty list, so this rule never sees it.
 */
export function overallOfChecks(items: { state: ForgeCheckState }[]): ForgeOverall {
  if (items.every((item) => isAcceptedCheckState(item.state))) return "green";
  if (items.some((item) => RED_STATES.has(item.state))) return "red";
  return "pending";
}

/** A completed check that does not block approval, including conditional skips. */
export function isAcceptedCheckState(state: ForgeCheckState): boolean {
  return state === "success" || state === "skipped";
}

/** A terminal non-success: the states that make a reading red. */
export function isRedCheckState(state: ForgeCheckState): boolean {
  return RED_STATES.has(state);
}

/** A check state in a tool's words: `completed / <conclusion>`, or still running. */
export function describeCheckState(state: ForgeCheckState): string {
  return state === "pending" ? "in_progress / -" : `completed / ${state}`;
}
