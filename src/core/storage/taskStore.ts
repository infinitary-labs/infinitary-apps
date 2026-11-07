import type {
  CheckRepairLedger,
  MergeRepairDeclaration,
  MergeRepairImpact,
} from "@shared/checkRepair";
import type { CheckSnapshot, MainCheckEvidence } from "@shared/checkSnapshot";
import { type HoldOverride, type OverridableHold, overridePasses } from "@shared/holds";
import type { LiveValidation } from "@shared/liveValidation";
import type { MergeReview } from "@shared/mergeReview";
import type { CommittedPlacement } from "@shared/placement";
import type { CaptainAction, RequiredActionOffer } from "@shared/requiredActions";
import type { ReviewRisk, ReviewVerdict } from "@shared/rigor";
import type { RiskAssessment } from "@shared/risk";
import type { WorkShape } from "@shared/routingPolicy";
import type { EffectiveTaskPolicies } from "@shared/taskPolicies";
import type { FirstRelease } from "@shared/taskRelease";
import type { RunChecks, TaskDeliveryMode } from "@shared/tasks";
import type { WriteAsk } from "@shared/writeAsk";
import type { SpawnIntent } from "../orchestrator/intentBrief";
import { ChangeStore } from "./changeStore";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import {
  composeDelivery,
  deliverySaveMoves,
  type EvidenceRow,
  type PermissionRow,
  splitDelivery,
  TaskDeliveryStore,
} from "./taskDeliveryStore";
import {
  EXECUTION_COLUMNS,
  NO_EXECUTION,
  splitTurn,
  type TaskExecution,
  TaskExecutionStore,
  withTurn,
} from "./taskExecutionStore";
import { TaskOwnedShapeStore } from "./taskOwnedShapeStore";
import { splitPolicies, TaskPolicyStore, withPolicies } from "./taskPolicyStore";
import {
  REFERENCE_SHAPE_FIELDS,
  TASK_REFERENCE_KINDS,
  type TaskReference,
  TaskReferenceStore,
} from "./taskReferenceStore";
import { TaskSpecificationStore } from "./taskSpecificationStore";

/**
 * The task record's row layer (task-system design section 4.1). A task is
 * a record, not a runtime handle: rows are created when intent exists and
 * are never deleted by success - settling closes them (captain decision
 * D2; the D-13 purge is the one destructive control). This store is raw
 * SQL over the row shape; every write in the app goes through
 * `src/core/tasks/taskService.ts`, which owns project resolution, keys,
 * transitions and the timeline event each change commits with.
 */

export type TaskStatus = "open" | "active" | "done" | "dropped";
export type TaskActivity = "starting" | "running" | "idle" | "interrupted";
export type TaskClosedReason =
  | "landed"
  | "merged"
  | "released"
  | "answered"
  | "settled"
  | "finished"
  | "cancelled"
  | "discarded"
  | "failed"
  | "superseded";
export type TaskKind = "work" | "question" | "decision" | "operation";
export type TaskStartPolicy = "when-ready" | "on-request";
export type TaskWorkspaceState = "none" | "present" | "removed";

export type TaskGate = {
  /**
   * What the row waits on: quota coming back for a scope, a moment in
   * time, or the user (a parked decision, or an explicit reasoning ask that
   * cannot be served yet). "After another task" is a `blocks` link now.
   */
  kind: "quota-reset" | "at-time" | "captain";
  /** The gate's subject: a quota scope (`bucket:high`), a card id. */
  ref?: string;
  /** Epoch ms when a time-gated row surfaces on its own. */
  until?: number;
  reason?: string;
};

export type PendingSettleIntent = {
  mode: "merge-pr" | "land";
  actor: "captain" | "firstmate" | "app";
  /** The merge card declared the task continues after this merge (INF-2744). */
  continues?: true;
  requestedAt: number;
  proceedWithOpen: boolean;
  /** One branch/local attempt waiting for a turn, not a kept hosted merge approval. */
  story?: { revision: number; head: string; contentHash?: string };
};

/**
 * The unversioned kept click of contract 4.66 (`TaskDelivery.mergeOrder`):
 * it names no approved head, so it is never carried forward - the boot
 * retires it and says so (FI3-304: no upgrade without a provable baseline).
 */
export type MergeOrder = { at: number; proceedWithOpen: boolean };

/**
 * A merge card the host published after its checks passed, and the
 * head those checks read: the baseline a click on that exact offer
 * approves. A card without one (seeded, or a Firstmate card) approves no head.
 * An offer that approves no head is still kept for the change it was shown
 * for (INF-2490), so its click refuses once another change is current.
 */
export type CompletionOffer = {
  cardId: string;
  offerId: string;
  headSha: string;
  /** Absent for a plain branch or local-only work; consent still binds the story and head. */
  prNumber?: number;
  /**
   * The task's current change, by number, when the card went up (INF-2490):
   * a click on it refuses once another change is current. A first mate
   * card's offer, and any offer that approves no head, names it here alone.
   */
  shownFor?: number;
  /** The merge card declared the task continues after this merge (INF-2744). */
  continues?: true;
  /** The saved story this offer showed, when it uses one. */
  presentationRevision?: number;
  presentationContentHash?: string;
  at: number;
};

/**
 * The independent assessment of a repair its crewmate declared unknown
 * (FI3-663): the task the host commissioned to read it and, once it
 * answered, its verdict. One per undecided repair.
 */
export type MergeRepairAssessment = {
  taskId: string;
  at: number;
  /**
   * `unstated`: it reported without the impact line; `failed`: it could not
   * start or ended with no report. Rows before INF-493 say `conflict-only` for `none`.
   */
  verdict?: MergeRepairImpact | "unstated" | "failed";
  decidedAt?: number;
};

/** One accepted repair of an approved change: the host checked its lineage and paths. */
export type MergeRepairStep = MergeRepairDeclaration & {
  /** The authorization generation it was accepted under. */
  generation: number;
  at: number;
  /**
   * An unknown repair's paths, read by the host when it was declared: those
   * the approved change touches against its own base and those the repaired
   * one touches against the newer base - what its independent assessment
   * judges.
   */
  paths?: { approved: string[]; repaired: string[] };
  /**
   * The repaired head's change reading, stored when the repair is recorded
   * (INF-416 G). Absent when that commit could not be read.
   */
  changeReading?: string;
  /** The independent assessment that decides an unknown repair. */
  assessment?: MergeRepairAssessment;
};

/** What a standing merge authorization is waiting on, in the host's typed terms. */
export type MergeWait =
  /** GitHub found the change in conflict with newer work, or behind it. */
  | "conflict"
  /** The pull request is at a head no accepted repair names yet. */
  | "repair"
  /** The newest repair was declared with an unknown impact: its independent assessment decides it. */
  | "evidence"
  /** The checks on the candidate head have not all passed. */
  | "checks"
  /** A round cap on the task holds it until the captain answers. */
  | "cap"
  /** GitHub holds the merge: a required review or another rule on the branch. */
  | "protected"
  /** GitHub has not worked out whether the change can merge yet. */
  | "computing"
  /** A draft pull request cannot merge. */
  | "draft"
  /** The sign-in where the project lives is missing or refused. */
  | "sign-in"
  /** A network or host hiccup. */
  | "transient"
  /** The merge request's outcome is unknown and is being read back. */
  | "outcome"
  /** Another refusal the crewmate can fix: a title, a missing version, access. */
  | "refused"
  /** The captain's newer guidance waits for its crewmate to declare its impact. */
  | "guidance"
  /** A queue-pr project's queue has not passed this version yet: its \`infinitary/queue\` status is waiting. */
  | "queue";

/**
 * The captain's merge approval (FI3-304), version 1: minted by his click on
 * a completion offer the host published at a known head, in the same
 * transaction as the card's resolution. It covers that pull request, that
 * head and the repairs the host accepted after it, and it
 * stands through conflicts, waits and restarts until it is consumed by the
 * merge, revoked (an interruption, his withdrawal), invalidated (the work
 * changed, the pull request or project is no longer the one approved) or
 * superseded (a new merge card or a new click). `generation` advances
 * on every one of those, so a run that started earlier can tell before it
 * sends anything.
 */
export type MergeAuthorization = {
  version: 1;
  id: string;
  generation: number;
  /**
   * Who approved it: the captain's click, or the app from the merge card
   * on a task whose autonomy is on (INF-2744). An app approval passes the
   * merge gate again on every run, so turning autonomy off ends it.
   */
  issuer: "captain" | "autonomy";
  at: number;
  /** The offer the captain clicked: the card, its occurrence and version, the action and the gesture. */
  card: {
    id: string;
    lifecycleId?: string;
    offerId: string;
    actionId: string;
    interactionId?: string;
  };
  /** Where the change lives and how it merges. */
  target: {
    repoId: string;
    host: string;
    owner: string;
    name: string;
    prNumber: number;
    branch: string;
    delivery: "direct-pr";
    method: "squash";
  };
  /** The head the captain approved: the one the merge card's checks read. */
  approvedHead: string;
  /** The reviewed pull request a merge card named; its snapshot survives review-list eviction. */
  review?: MergeReview;
  /**
   * What the merge card declared follows the merge (INF-2744). Absent on an
   * approval from before it: a review's merge continued the task, the
   * current change's closed it.
   */
  after?: "close" | "continue";
  /**
   * The approved head's change reading, stored at the captain's approval
   * (INF-416 G). Absent when that commit could not be read.
   */
  changeReading?: string;
  /** Accepted repairs, each declared to leave the approved work as it was, oldest first. */
  lineage: MergeRepairStep[];
  /** The captain's leave to merge with open children (`proceed_with_open`). */
  proceedWithOpen: boolean;
  status: "standing" | "consumed" | "revoked" | "invalidated" | "superseded";
  /** Why it ended, in the host's words. */
  reason?: string;
  endedAt?: number;
  /**
   * The end holds the task's merge for the captain: he withdrew it, or the
   * work changed under it. Project autonomy does not merge past it; a new
   * click does.
   */
  holds?: boolean;
  /** What the newest run stopped on while it stands. */
  waiting?: { on: MergeWait; head?: string; at: number };
  /**
   * A declared repair whose impact is unknown: not eligible until its
   * independent assessment decides it (FI3-663).
   */
  undecided?: MergeRepairStep;
  /**
   * The captain's guidance since his click (FI3-662): each steer or reply
   * of his takes the next mark, and the merge holds while `latest` is past
   * `declared`, the newest mark its crewmate declared it read and judged.
   */
  guidance?: { latest: number; declared: number; at: number };
  /** When the tick tries a timed wait again, and how many times it has. */
  retryAt?: number;
  retries?: number;
  /** Persisted right before the merge request is sent; its answer clears it. */
  attempt?: { token: string; head: string; at: number };
  /** The merge GitHub confirmed. */
  receipt?: { head: string; sha?: string; at: number };
  /**
   * Approvals of the task's other pull requests, kept while this one
   * stands (INF-2746): a task may ask for many merges, and every merge
   * card's approval stands on its own until its pull request merges. When
   * this one ends the oldest stands next; an end that holds the task's
   * merge for the captain, or revokes it, ends them too. Each carries no
   * queue of its own.
   */
  queued?: MergeAuthorization[];
};

/**
 * The app's own mark on a waiting version: the version, the status id the
 * host gave the mark back, when it was made, and whether anything has
 * written the status since.
 */
export type QueueMark = { head: string; id?: number; at: number; answered?: boolean };

/** Delivery facts, as they become known (check_pr_ci, land, merge-pr, review). */
export type TaskDelivery = {
  /**
   * The task's latest typed result as a release before INF-1296 piece 1
   * kept it: a copy of the newest report's. Nothing writes it now; the
   * report entries hold the result, and `TaskService.latestResult` still
   * reads a copy saved before, with the precedence it had.
   */
  result?: { at: number; value: Record<string, unknown> };
  /**
   * Versioned public story and native-upload receipts of the task's current
   * change; only TaskService writes them. Each other change keeps its own in
   * `presentations` (INF-2490).
   */
  presentation?: import("@shared/changePresentation").ChangePresentationRecord;
  /**
   * The story ledgers of the task's other changes, each naming its branch
   * (INF-2490). When another change becomes the current one, its ledger
   * moves into `presentation` and the one it replaces moves here.
   */
  presentations?: import("@shared/changePresentation").ChangePresentationRecord[];
  liveValidation?: LiveValidation;
  validationAssignment?: {
    head: string;
    revision: number;
    scenarioRevision: number;
    stateRevision?: number;
    effects: string[];
  };
  validationHead?: string;
  validationReadiness?: {
    head: string;
    number: number;
    state: "unknown" | "not-applied" | "ready";
    problem?: string;
  };
  reviewRoundPairs?: string[];
  requiredActionOffer?: RequiredActionOffer;
  captainAction?: CaptainAction;
  /** Policies frozen with the closed outcome, never a routing/dispatch stamp. */
  closedPolicies?: EffectiveTaskPolicies;
  mode: TaskDeliveryMode;
  prUrl?: string;
  prNumber?: number;
  /**
   * How the proposed change is named where the project lives, from the
   * forge seam (git integration PR 1.1): `#N` on GitHub, the sent-up branch
   * on a plain Git host. Surfaces read it instead of parsing a link.
   */
  changeLabel?: string;
  /**
   * The branch the pull request targets, as the host names it (INF-1873):
   * the default branch, or the branch `open_change` asked for. Written with
   * the number group and refreshed by each reading; the change record's base.
   */
  prBase?: string;
  /** The PR head the last CI read saw, or the assigned commit on an independent review task. */
  headSha?: string;
  /**
   * The lines the whole offered change adds and deletes (INF-820), read by
   * the host from git at `head` against the merge base `base`; the fact
   * strip shows them only while `head` is the offered version. Absent
   * until a reading succeeded: an unread change is never zero.
   */
  changeLines?: { base: string; head: string; added: number; deleted: number; at: number };
  ci?: "green" | "red" | "pending" | "no-pr" | "merged";
  ciAt?: number;
  /** Current raw check facts; the merge offer itself is the crew's judgment. */
  checks?: CheckSnapshot;
  /** A raw reading's durable identity; forwarded by a tool response or the inbox, never a verdict. */
  ciObservation?: { id: string; signature: string; forwarded: boolean; notice?: string };
  /** When the host says the first check on that head started (INF-587). */
  ciStartedAt?: number;
  /** When the checks finished: the last finish when green, the first failure's when red. */
  ciFinishedAt?: number;
  /**
   * The default branch's newest run of each check the reading at `head` found
   * red (INF-1915 fix 1), read with that reading of the task's own pull
   * request and replaced or cleared by the next. Evidence about a failure's
   * cause for the crew's diagnosis and the merge card, never a merge
   * input: the merge boundary does not read it; the merge card's
   * checks hold does, letting the card up at once when that branch fails
   * every failed check too (`CrewmateCards.pendingCiGate`).
   */
  mainChecks?: MainCheckEvidence & { head: string };
  /** The newest watched run's state and host times, kept after its watch ends (INF-594). */
  runChecks?: RunChecks;
  landedMode?: "fast-forward" | "merge" | "pr";
  /**
   * The branch head a local merge landed (INF-2678): the version its
   * receipt names, so after a merge that kept the task open a later story
   * of the same change waits for its own merge.
   */
  landedHead?: string;
  /** The resulting merge, not the proposed branch head. */
  mergedSha?: string;
  /** Earliest published release verified to contain the change; absent is unknown. */
  firstRelease?: FirstRelease;
  /**
   * The independent review's latest verdict on a reviewed task (delivery
   * rigor phase 2), recorded on the BUILDER: the verdict, the head the
   * reviewer read, and the risk it named beside CI (never a hold, Q4). The
   * review that recorded it is read off the parent edge
   * (`TaskService.graph.verdictReviewOf`), never cached here.
   */
  reviewVerdict?: ReviewVerdict;
  reviewSha?: string;
  /**
   * The change reading the review was assigned, sha256 of the
   * position-stripped diff (INF-148). Absent when that commit could not
   * be read, including a computer on an older app.
   */
  reviewChange?: string;
  /**
   * On a REVIEW task: the version an earlier review of its builder passed,
   * when this review was commissioned for a later one (INF-401). Every
   * turn of this review reads only the difference since it. Not a
   * published field.
   */
  passedHead?: string;
  /**
   * A later head a pass covered because its change reading matched.
   * No longer written: the reading stored with that version covers it.
   * An older record's value still covers its head.
   */
  reviewCarrySha?: string;
  /**
   * Change readings stored with a version before it is an approval or a
   * repair, keyed by head (INF-416 G). Not a published field.
   */
  versionReadings?: Record<string, string>;
  reviewRisk?: ReviewRisk;
  reviewRiskNote?: string;
  reviewedAt?: number;
  /**
   * The declaration record and preserved legacy count fields.
   * The host never increments these counts or uses their caps as holds.
   */
  ciRepair?: CheckRepairLedger;
  ciRounds?: number;
  ciRedHead?: string;
  ciCapAt?: number;
  reviewRounds?: number;
  /** The head the last COUNTED findings round read: a round is one per head. */
  reviewRoundSha?: string;
  reviewCapAt?: number;
  /** Absent on older holds: those remain captain-owned. */
  reviewCapOwner?: "firstmate" | "captain";
  capAnsweredAt?: number;
  /**
   * The captain's one recorded override (docs/delivery-rigor.md, "The
   * holds"): his words, the soft holds the first mate declared they pass,
   * and for how long. Only update_task override writes it, in a turn that
   * carries his words; `override` with empty `holds` clears it.
   */
  override?: HoldOverride;
  /**
   * The host's watch on the change's checks (docs/forge.md, "The check
   * watch"): present while a reading found them running and the host reads
   * them for the crewmate, absent otherwise.
   */
  ciWatch?: CiWatch;
  /**
   * The app's own mark on the version waiting for the project's queue
   * (docs/forge.md, "A project's queue"): the status id the host gave it back,
   * so a later write by anything else reads as an answer.
   */
  queueMark?: QueueMark;
  /** Non-PR run watches, saved until their named terminal wake or a crewmate outcome read. */
  runWatches?: RunWatch[];
  /** Contract 4.66's unversioned kept click; retired at boot, never run. */
  mergeOrder?: MergeOrder;
  /**
   * The captain's merge approval and its lifecycle (FI3-304,
   * docs/delivery-rigor.md "A kept merge approval"): the newest one, standing
   * or ended. An ended one stays as the record of how it ended.
   */
  mergeAuthorization?: MergeAuthorization;
  /**
   * Reviewed pull requests a merge card may name (FI3-1543).
   * Selecting a referenced one updates the displayed `prNumber` and checks,
   * but only `checkTarget` selects it; the task's own branch remains its own.
   */
  mergeReviews?: MergeReview[];
  /** Explicitly selected referenced pull request for status and check watches, never branch ownership. */
  checkTarget?: MergeReview;
  /**
   * Writes the crewmate asked to send where a project lives, kept until the
   * captain's click sends one (FI3-1571 piece 4). `TaskService` is their one
   * writer: it keeps, takes and records them, and a close drops the ones
   * never sent.
   */
  writeAsks?: WriteAsk[];
  /** The newest completion offers the host published, with the head each one's checks read. */
  completionOffers?: CompletionOffer[];
  /**
   * The risk assessment on the newest merge card the host published
   * (docs/card-authoring.md "The risk chart"): its crewmate's levels and
   * lines alone. A new merge card replaces it.
   */
  risk?: RiskAssessment;
  /**
   * The host's last refusal of this task's merge card, present until
   * a merge card goes up (docs/card-authoring.md, "A refused
   * merge card"): what the report wake and `crew_status` say beside
   * a report that claims the card went up.
   */
  cardRefusal?: CardRefusal;
  /**
   * What the crewmate's latest report declared about whose turn follows it
   * (FI3-435): it waits on the captain (`captainWait`, which places the
   * task's `captain` gate), or its work is finished and the captain has
   * acknowledged its outcome (`finishedAt`). Present from that report until
   * its next turn starts, including an ordinary-read or duplicate notification.
   * Aside and saved-answer reads do not start that turn.
   */
  captainWait?: CaptainWait;
  finishedAt?: number;
  /**
   * Beside either, what that report asked the Firstmate to do (FI3-710,
   * `needs_firstmate`), kept until the crewmate's next turn starts so the
   * idle ladder can raise it again while the Firstmate has not acted on
   * the task since (FI3-714).
   */
  needsFirstmate?: FirstmateAsk;
  /**
   * Beside a running job, when that report said its crewmate looks at it
   * again and what it waits for (INF-1244, `check_back`): kept until its
   * next turn starts, with the task's `at-time` gate it places.
   */
  checkBack?: CheckBack;
};

/** A crewmate's check-back: when its report named it, when it is due, and what it waits for. */
export type CheckBack = { at: number; until: number; waitingFor: string };

/** A wait on the captain a crewmate declared in its report: why, and the card he is to read. */
export type CaptainWait = { at: number; reason: string; cardId?: string };

/** A crewmate's request that the Firstmate act: when its report asked, and what. */
export type FirstmateAsk = { at: number; request: string };

/**
 * Why the host refused a merge card: its checks had not passed, the
 * CI cap holds it, its review has not passed, its shape failed the card
 * lint, or anything else the emit refused (its size, id or pictures) -
 * `why` carries the host's own words for each.
 */
export type CardRefusalReason = "checks" | "ci-cap" | "review" | "shape" | "other";

/** One refused merge card: the title it was emitted with, when, and why. */
export type CardRefusal = {
  at: number;
  title: string;
  reason: CardRefusalReason;
  why: string;
};

/** One named run, its current attempt, bound and next read, and whether its early failure is known. */
export type RunWatch = {
  runId: number;
  name: string;
  attempt: number;
  since: number;
  nextAt: number;
  failureSeen?: boolean;
};

/**
 * One check watch, durable so it outlives a restart: the head it watches,
 * when it began at that head (what bounds it and names its wakes), when it
 * reads next, how many reads it has taken, and whether the early failure
 * wake for this head already went or the crewmate already read a red check.
 */
export type CiWatch = {
  head: string;
  since: number;
  nextAt: number;
  tries: number;
  failureSeen?: boolean;
};

export type TaskRecord = {
  id: string;
  /** `<PROJECT_KEY>-<seq>`, the conversational handle (D6). */
  key: string;
  seq: number;
  projectId: string;
  parentId: string | null;
  kind: TaskKind;
  title: string;
  /** The intent's one sentence of what done looks like. */
  goal: string | null;
  /** The structured spawn intent, when the task was commissioned from one. */
  intent: SpawnIntent | null;
  /** The rendered structured task brief. */
  prompt: string;
  repoId: string | null;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  sessionFile: string | null;
  /** The vault account the crewmate is bound to; null = base runtime. */
  accountId: string | null;
  /**
   * The computer that runs work for this home where the task's crewmate
   * runs (docs/helper.md, "Holding a conversation"); null, or absent on a
   * row read before the column, is this Mac.
   */
  deviceId?: string | null;
  placement?: CommittedPlacement | null;
  /**
   * The tier this task routes at, carried to dispatch (P7/R1). Computed by
   * the work-shape policy since S2 (`src/core/routing/policy.ts`), not
   * judged by the Firstmate; `premium` is only ever reached by the
   * captain's own ask or an escalation.
   */
  difficulty: "low" | "medium" | "high" | "premium" | null;
  /**
   * The work shape that tier was computed from (S2). Null on rows written
   * before the shape existed, and on rows that never routed.
   */
  shape: WorkShape | null;
  gate: TaskGate | null;
  /**
   * open (waiting to start), active (a crewmate has it, including idle with
   * unlanded work waiting to be merged, landed or discarded), done (landed,
   * merged, released, answered or settled), dropped (cancelled, discarded, failed,
   * superseded).
   */
  status: TaskStatus;
  /** While active: what the crewmate is doing right now. */
  activity: TaskActivity | null;
  closedReason: TaskClosedReason | null;
  /** 0 urgent .. 3 low; 2 by default. */
  priority: number;
  startPolicy: TaskStartPolicy;
  /** About the worktree only; the session JSONL is kept regardless (D2). */
  workspaceState: TaskWorkspaceState;
  /** The latest complete report, in full and as its first sentence. */
  outcome: string | null;
  outcomeSummary: string | null;
  delivery: TaskDelivery | null;
  /** A merge/land click captured while the crewmate's current turn finishes. */
  pendingSettle?: PendingSettleIntent | null;
  /**
   * The idle clock (docs/report-sort.md, "The idle ladder"): when the
   * crewmate last went idle, null while a turn runs. Durable, so a restart
   * or a sleep reads the same clock.
   */
  idleSince?: number | null;
  /** The ladder's highest rung this idle episode: 0 none, 1 nudged, 2 woken, 3 card raised. */
  recoveryRung?: number;
  /** The Firstmate wakes this idle episode sent. */
  recoveryCount?: number;
  /** When the ladder last acted this episode. */
  recoveryAt?: number | null;
  /** The crewmate label and routed model id (denormalized; logs stay authoritative). */
  assignee: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  closedAt: number | null;
  /**
   * The failing test a filing names (quiet ledger). The host refuses a
   * second open row for the same path. Null on every other row.
   */
  testPath?: string | null;
  /** When the captain first opened this record. Null until then. */
  captainOpenedAt?: number | null;
  /** The Firstmate's one-line verdict on a filing. Null until recorded. */
  verdict?: string | null;
  /**
   * A confirmed manual start that did not begin, as JSON `{ reason }`.
   * Null once retried or resolved, and on rows written before the column.
   */
  startNotice?: string | null;
  /**
   * When this started task went back to the backlog (INF-2062): it waits
   * for a Start with its work kept, and nothing the host sends wakes it.
   * Null while it is not there; only `task_execution` holds it.
   */
  backlogSince?: number | null;
};

/** What a search of closed work reads of each row (`TaskStore.listClosedSearchFields`). */
export type TaskSearchFields = Pick<
  TaskRecord,
  "id" | "key" | "kind" | "status" | "title" | "goal" | "closedAt"
>;

/** The work facts ask coverage and its summaries need, without composed payloads. */
export type TaskCoverageFields = Pick<
  TaskRecord,
  "id" | "key" | "title" | "status" | "closedReason" | "createdAt" | "startedAt"
>;

type Row = {
  id: string;
  key: string | null;
  seq: number | null;
  project_id: string | null;
  parent_id: string | null;
  kind: TaskKind;
  title: string;
  goal: string | null;
  intent_json: string | null;
  prompt: string;
  repo_id: string | null;
  repo_dir: string;
  worktree_dir: string;
  branch: string;
  session_file: string | null;
  account_id: string | null;
  device_id?: string | null;
  placement_json?: string | null;
  difficulty: TaskRecord["difficulty"];
  shape_json: string | null;
  gate_kind: TaskGate["kind"] | null;
  gate_ref: string | null;
  gate_until: number | null;
  gate_reason: string | null;
  status: TaskStatus;
  activity: TaskActivity | null;
  closed_reason: TaskClosedReason | null;
  priority: number;
  start_policy: TaskStartPolicy;
  workspace_state: TaskWorkspaceState;
  outcome: string | null;
  outcome_summary: string | null;
  delivery_json: string | null;
  pending_settle_json: string | null;
  idle_since: number | null;
  recovery_rung: number | null;
  recovery_count: number | null;
  recovery_at: number | null;
  assignee: string | null;
  model: string | null;
  created_at: number;
  updated_at: number | null;
  started_at: number | null;
  closed_at: number | null;
  test_path?: string | null;
  captain_opened_at?: number | null;
  verdict?: string | null;
  start_notice?: string | null;
};

/**
 * The shape as the record stores it. The basis verdict is derived at every
 * read (`TaskService.graph.basisHolds`) and never stored: a stamp goes stale the
 * moment the basis answers. The relationships a shape is read with live in
 * `task_references` (INF-1296 piece 2), so they never reach the column.
 */
function shapeJson(shape: WorkShape | null | undefined): string | null {
  if (!shape) return null;
  const {
    basis_verified: _derived,
    basis: _basis,
    branch_from: _branch,
    escalate_from: _retry,
    ...recorded
  } = shape;
  return JSON.stringify(recorded);
}

/** A shape as it is read: the stored fields, and each reference under its older field. */
function withReferences(
  shape: WorkShape | null,
  references: readonly TaskReference[] | undefined,
): WorkShape | null {
  if (!shape || !references?.length) return shape;
  const composed: WorkShape = { ...shape };
  for (const reference of references)
    composed[REFERENCE_SHAPE_FIELDS[reference.kind]] = reference.ref;
  return composed;
}

/** A task's change evidence and permission rows, as `TaskDeliveryStore` holds them. */
type DeliveryRecords = { evidence?: EvidenceRow; permissions?: PermissionRow };

/**
 * A record's delivery facts and its settle that has not run, as its
 * evidence and permission rows hold them beside the history its column
 * keeps (INF-1296 piece 4). An older field nothing reads stays out, as it
 * did when the column held it.
 */
function withDeliveryRecords(record: TaskRecord, rows: DeliveryRecords): TaskRecord {
  const delivery = composeDelivery(
    record.delivery as Record<string, unknown> | null,
    rows.evidence,
    rows.permissions,
  );
  return {
    ...record,
    delivery: withoutRetired(delivery as TaskDelivery | null, "landedAt"),
    pendingSettle: parseJson<PendingSettleIntent>(rows.permissions?.pending_settle_json ?? null),
  };
}

/**
 * A record as it is read (INF-1296 pieces 2 to 4): its row, its shape with
 * its references and policy inputs, its running work as `task_execution`
 * holds it, and its delivery facts with their evidence and permission
 * rows. `execution` and `delivery` are undefined on a database from before
 * those tables, whose row still holds those columns itself.
 */
function composed(
  record: TaskRecord,
  references: readonly TaskReference[] | undefined,
  policies: Parameters<typeof withPolicies>[1],
  execution: TaskExecution | undefined,
  delivery?: DeliveryRecords,
): TaskRecord {
  const shape = withPolicies(withReferences(record.shape, references), policies);
  if (delivery) record = withDeliveryRecords(record, delivery);
  if (!execution) return shape === record.shape ? record : { ...record, shape };
  return {
    ...record,
    shape,
    sessionFile: execution.sessionFile,
    accountId: execution.accountId,
    deviceId: execution.deviceId,
    placement: execution.placement,
    idleSince: execution.idleSince,
    recoveryRung: execution.recoveryRung,
    recoveryCount: execution.recoveryCount,
    recoveryAt: execution.recoveryAt,
    startNotice: execution.startNotice,
    backlogSince: execution.backlogSince,
    delivery: withTurn(record.delivery, execution.turn),
  };
}

/**
 * A field an older build saved that nothing reads any more (INF-1288 piece 3):
 * a read leaves it out, so no surface shows it and the row's next write
 * no longer carries it. No migration rewrites the rows, so an older build
 * still opens the profile.
 */
function withoutRetired<T extends object>(value: T | null, field: string): T | null {
  if (!value || !Object.hasOwn(value, field)) return value;
  const { [field]: _retired, ...kept } = value as Record<string, unknown>;
  return kept as T;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function fromRow(row: Row): TaskRecord {
  return {
    id: row.id,
    key: row.key ?? "",
    seq: row.seq ?? 0,
    projectId: row.project_id ?? "",
    parentId: row.parent_id,
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    intent: parseJson<SpawnIntent>(row.intent_json),
    prompt: row.prompt,
    repoId: row.repo_id,
    repoDir: row.repo_dir,
    worktreeDir: row.worktree_dir,
    branch: row.branch,
    sessionFile: row.session_file,
    accountId: row.account_id,
    deviceId: row.device_id ?? null,
    placement: parseJson<CommittedPlacement>(row.placement_json ?? null),
    difficulty: row.difficulty,
    shape: withoutRetired(parseJson<WorkShape>(row.shape_json), "knowledge_access"),
    gate: row.gate_kind
      ? {
          kind: row.gate_kind,
          ...(row.gate_ref ? { ref: row.gate_ref } : {}),
          ...(row.gate_until !== null ? { until: row.gate_until } : {}),
          ...(row.gate_reason ? { reason: row.gate_reason } : {}),
        }
      : null,
    status: row.status,
    activity: row.activity,
    closedReason: row.closed_reason,
    priority: row.priority,
    startPolicy: row.start_policy,
    workspaceState: row.workspace_state,
    outcome: row.outcome,
    outcomeSummary: row.outcome_summary,
    delivery: withoutRetired(parseJson<TaskDelivery>(row.delivery_json), "landedAt"),
    pendingSettle: parseJson<PendingSettleIntent>(row.pending_settle_json),
    idleSince: row.idle_since,
    recoveryRung: row.recovery_rung ?? 0,
    recoveryCount: row.recovery_count ?? 0,
    recoveryAt: row.recovery_at,
    assignee: row.assignee,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    testPath: row.test_path ?? null,
    captainOpenedAt: row.captain_opened_at ?? null,
    verdict: row.verdict ?? null,
    startNotice: row.start_notice ?? null,
  };
}

/**
 * Oldest first: created, then key number (a missing one first). Sorted here,
 * never by an ORDER BY over these rows: SQLite's sorter copies every column
 * of every row, and once that copy outgrows its cache it writes it to a
 * temporary file, tens of megabytes per read of a long record, on the main
 * thread (INF-940).
 */
export function oldestFirst(records: TaskRecord[]): TaskRecord[] {
  return records.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
}

/** The columns a patch may touch, mapped from record field to column. */
const PATCH_COLUMNS = {
  key: "key",
  seq: "seq",
  projectId: "project_id",
  parentId: "parent_id",
  title: "title",
  goal: "goal",
  prompt: "prompt",
  repoId: "repo_id",
  repoDir: "repo_dir",
  worktreeDir: "worktree_dir",
  branch: "branch",
  sessionFile: "session_file",
  accountId: "account_id",
  deviceId: "device_id",
  status: "status",
  activity: "activity",
  closedReason: "closed_reason",
  priority: "priority",
  startPolicy: "start_policy",
  workspaceState: "workspace_state",
  outcome: "outcome",
  outcomeSummary: "outcome_summary",
  assignee: "assignee",
  model: "model",
  difficulty: "difficulty",
  idleSince: "idle_since",
  recoveryRung: "recovery_rung",
  recoveryCount: "recovery_count",
  recoveryAt: "recovery_at",
  updatedAt: "updated_at",
  startedAt: "started_at",
  closedAt: "closed_at",
  testPath: "test_path",
  captainOpenedAt: "captain_opened_at",
  verdict: "verdict",
  startNotice: "start_notice",
  backlogSince: "backlog_since",
} as const;

type PatchField = keyof typeof PATCH_COLUMNS;

export type TaskPatch = Partial<Pick<TaskRecord, PatchField>> & {
  placement?: CommittedPlacement | null;
  intent?: SpawnIntent | null;
  /** The work shape (S3): written as JSON, like the other structured columns. */
  shape?: WorkShape | null;
  gate?: TaskGate | null;
  delivery?: TaskDelivery | null;
  pendingSettle?: PendingSettleIntent | null;
};

/** The patch fields that can move the change a task carries (INF-1868 piece 1). */
const CHANGE_PATCH_FIELDS: readonly (keyof TaskPatch)[] = [
  "delivery",
  "status",
  "closedReason",
  "closedAt",
  "branch",
  "repoId",
  "shape",
];

export class TaskStore {
  private taskColumns: Set<string> | undefined;
  private projection:
    | {
        records: Map<string, TaskRecord | undefined>;
        lists: Map<string, TaskRecord[]>;
        coverage: Map<string, TaskCoverageFields | undefined>;
      }
    | undefined;

  /** A synchronous derived view composes each task once, including nested readers. */
  readProjection<T>(read: () => T, known: readonly TaskRecord[] = []): T {
    const outer = this.projection;
    this.projection ??= { records: new Map(), lists: new Map(), coverage: new Map() };
    try {
      // The board's row-cache owner already has these current records.
      // Prefer a row this projection read itself when one is present.
      for (const record of known)
        if (!this.projection.records.has(record.id)) this.projection.records.set(record.id, record);
      return read();
    } finally {
      if (!outer) this.projection = undefined;
    }
  }

  /** Writes see their own current rows, and invalidate any surrounding projection even on rollback. */
  writeOutsideProjection<T>(write: () => T): T {
    const projection = this.projection;
    this.projection = undefined;
    try {
      return write();
    } finally {
      projection?.records.clear();
      projection?.lists.clear();
      projection?.coverage.clear();
      this.projection = projection;
    }
  }
  /** Read here so a record's shape carries them; written only by TaskService. */
  readonly references: TaskReferenceStore;
  /** A task's running work (INF-1296 piece 3); a record reads it in its own fields. */
  readonly execution: TaskExecutionStore;
  /** A task's policy inputs (INF-1296 piece 3); a record's shape reads them. */
  readonly policies: TaskPolicyStore;
  /** A task's change evidence and permissions (INF-1296 piece 4); a record's delivery reads them. */
  readonly delivery: TaskDeliveryStore;
  /** The change a task carries (INF-1868 piece 1), projected from its record on every write that can move it. */
  readonly changes: ChangeStore;
  readonly specifications: TaskSpecificationStore;
  readonly shapes: TaskOwnedShapeStore;

  constructor(private readonly db: AppDatabase) {
    this.specifications = new TaskSpecificationStore(db);
    this.shapes = new TaskOwnedShapeStore(db);
    this.references = new TaskReferenceStore(db);
    this.execution = new TaskExecutionStore(db);
    this.policies = new TaskPolicyStore(db);
    this.delivery = new TaskDeliveryStore(db);
    this.changes = new ChangeStore(db);
  }

  /** Writes the change this task's record now describes, once its saved row says so. */
  private projectChange(id: string): void {
    if (!this.changes.exists()) return;
    const saved = this.get(id);
    if (saved) this.changes.project(saved);
  }

  /** Older migration fixtures still read the schema they were written against. */
  private readTable(): string {
    return this.specifications.exists() ? "task_records" : "tasks";
  }

  private record(row: Row): TaskRecord {
    const known = this.projection?.records.get(row.id);
    if (known) return known;
    const record = fromRow(row);
    const result = composed(
      record,
      record.shape ? this.references.list(record.id) : undefined,
      record.shape ? this.policies.get(record.id) : undefined,
      this.execution.exists() ? this.execution.get(record.id) : undefined,
      this.delivery.exists()
        ? {
            evidence: this.delivery.evidence(record.id),
            permissions: this.delivery.permissions(record.id),
          }
        : undefined,
    );
    this.projection?.records.set(row.id, result);
    return result;
  }

  private read(rows: Row[]): TaskRecord[] {
    const records = rows.filter((row) => !this.projection?.records.has(row.id)).map(fromRow);
    const shaped = records.filter((record) => record.shape).map((record) => record.id);
    const references = this.references.listFor(shaped);
    const policies = this.policies.listFor(shaped);
    const executing = this.execution.exists();
    const execution = this.execution.listFor(executing ? records.map((record) => record.id) : []);
    const delivering = this.delivery.exists();
    const delivery = this.delivery.listFor(delivering ? records.map((record) => record.id) : []);
    const composedRecords = records.map((record) =>
      composed(
        record,
        references.get(record.id),
        policies.get(record.id),
        executing ? (execution.get(record.id) ?? NO_EXECUTION) : undefined,
        delivering
          ? {
              evidence: delivery.evidence.get(record.id),
              permissions: delivery.permissions.get(record.id),
            }
          : undefined,
      ),
    );
    if (!this.projection) return composedRecords;
    for (const record of composedRecords) this.projection.records.set(record.id, record);
    return rows.flatMap((row) => {
      const record = this.projection?.records.get(row.id);
      return record ? [record] : [];
    });
  }

  /**
   * A shape write never changes a relationship (INF-1296 piece 2): those go
   * through TaskService's checked relationship operations. A shape that names
   * one other than the record's is a writer's mistake, refused before it
   * writes; one that leaves it out leaves the relationship standing.
   */
  private assertReferencesKept(id: string, shape: WorkShape | null | undefined): void {
    if (!shape) return;
    const stored = new Map(
      this.references.list(id).map((reference) => [reference.kind, reference.ref]),
    );
    for (const kind of TASK_REFERENCE_KINDS) {
      const named = shape[REFERENCE_SHAPE_FIELDS[kind]];
      if (typeof named !== "string" || !named.trim() || named === stored.get(kind)) continue;
      throw new Error(
        `${REFERENCE_SHAPE_FIELDS[kind]} is the task's ${kind} relationship; set it through TaskService, not the shape.`,
      );
    }
  }

  /** Column names as this database has them. Migration tests seed on an older schema. */
  private columns(): Set<string> {
    this.taskColumns ??= new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    return this.taskColumns;
  }

  /**
   * Tasks left mid-turn by a previous process are interrupted, not silently
   * resurrected. Open rows are untouched: waiting survives a restart. A turn
   * on a computer that runs work went on without this process, so its row
   * is left as it was until that computer says where the turn is.
   */
  interruptLeftRunning(now: number): void {
    const here = this.execution.exists()
      ? " AND id NOT IN (SELECT task_id FROM task_execution WHERE device_id IS NOT NULL)"
      : this.columns().has("device_id")
        ? " AND device_id IS NULL"
        : "";
    this.db
      .prepare(
        `UPDATE tasks SET activity = 'interrupted', updated_at = ? WHERE status = 'active' AND activity IN ('running', 'starting')${here}`,
      )
      .run(now);
  }

  insert(record: TaskRecord): void {
    this.db.transaction(() => this.insertRows(record))();
  }

  private insertRows(record: TaskRecord): void {
    this.assertReferencesKept(record.id, record.shape);
    const filing = this.columns().has("test_path");
    // The running work and the policy inputs have rows of their own once
    // their tables exist (INF-1296 piece 3); before, the row holds them.
    const executing = this.execution.exists();
    const { shape, row: policies } = this.policies.exists()
      ? splitPolicies(record.shape)
      : { shape: record.shape, row: null };
    const { delivery, turn } = executing
      ? splitTurn(record.delivery)
      : { delivery: record.delivery, turn: null };
    const kept = executing ? NO_EXECUTION : record;
    // The change evidence and permissions have rows of their own once their
    // tables exist (INF-1296 piece 4); the column keeps the history.
    const delivering = this.delivery.exists();
    const history = delivering && delivery ? splitDelivery(delivery).history : delivery;
    if (this.specifications.exists()) {
      const values = {
        id: record.id,
        key: record.key,
        seq: record.seq,
        project_id: record.projectId,
        parent_id: record.parentId,
        kind: record.kind,
        title: record.title,
        repo_id: record.repoId,
        repo_dir: record.repoDir,
        worktree_dir: record.worktreeDir,
        branch: record.branch,
        difficulty: record.difficulty,
        gate_kind: record.gate?.kind ?? null,
        gate_ref: record.gate?.ref ?? null,
        gate_until: record.gate?.until ?? null,
        gate_reason: record.gate?.reason ?? null,
        status: record.status,
        activity: record.activity,
        closed_reason: record.closedReason,
        priority: record.priority,
        start_policy: record.startPolicy,
        workspace_state: record.workspaceState,
        outcome: record.outcome,
        outcome_summary: record.outcomeSummary,
        assignee: record.assignee,
        model: record.model,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        started_at: record.startedAt,
        closed_at: record.closedAt,
        test_path: record.testPath ?? null,
        captain_opened_at: record.captainOpenedAt ?? null,
        verdict: record.verdict ?? null,
      };
      const fields = Object.keys(values);
      this.db
        .prepare(
          `INSERT INTO tasks (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
        )
        .run(...Object.values(values));
      this.specifications.revise(record.id, {
        goal: record.goal,
        prompt: record.prompt,
        intent: record.intent,
      });
      this.shapes.replace(record.id, shape ? JSON.parse(shapeJson(shape)!) : null);
      this.db
        .prepare("INSERT INTO task_record_history (task_id, delivery_json) VALUES (?, ?)")
        .run(record.id, history ? JSON.stringify(history) : null);
    } else {
      this.db
        .prepare(
          `INSERT INTO tasks (
           id, key, seq, project_id, parent_id, kind, title, goal, intent_json, prompt,
           repo_id, repo_dir, worktree_dir, branch, session_file, account_id, difficulty, shape_json,
           gate_kind, gate_ref, gate_until, gate_reason, status, activity, closed_reason,
           priority, start_policy, workspace_state, outcome, outcome_summary, delivery_json,
           pending_settle_json, assignee, model, created_at, updated_at, started_at, closed_at,
           idle_since, recovery_rung, recovery_count, recovery_at${filing ? ",\n           test_path, captain_opened_at, verdict" : ""}
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?${filing ? ",\n           ?, ?, ?" : ""}
         )`,
        )
        .run(
          record.id,
          record.key,
          record.seq,
          record.projectId,
          record.parentId,
          record.kind,
          record.title,
          record.goal,
          record.intent ? JSON.stringify(record.intent) : null,
          record.prompt,
          record.repoId,
          record.repoDir,
          record.worktreeDir,
          record.branch,
          kept.sessionFile,
          kept.accountId,
          record.difficulty,
          shapeJson(shape),
          record.gate?.kind ?? null,
          record.gate?.ref ?? null,
          record.gate?.until ?? null,
          record.gate?.reason ?? null,
          record.status,
          record.activity,
          record.closedReason,
          record.priority,
          record.startPolicy,
          record.workspaceState,
          record.outcome,
          record.outcomeSummary,
          history ? JSON.stringify(history) : null,
          !delivering && record.pendingSettle ? JSON.stringify(record.pendingSettle) : null,
          record.assignee,
          record.model,
          record.createdAt,
          record.updatedAt,
          record.startedAt,
          record.closedAt,
          kept.idleSince ?? null,
          kept.recoveryRung ?? 0,
          kept.recoveryCount ?? 0,
          kept.recoveryAt ?? null,
          ...(filing
            ? [record.testPath ?? null, record.captainOpenedAt ?? null, record.verdict ?? null]
            : []),
        );
    }
    if (policies) this.policies.set(record.id, policies);
    if (delivering) {
      this.delivery.setDelivery(record.id, delivery);
      if (record.pendingSettle) this.delivery.setPendingSettle(record.id, record.pendingSettle);
    }
    if (executing) {
      const running: Partial<TaskExecution> = {
        ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
        ...(record.accountId ? { accountId: record.accountId } : {}),
        ...(record.idleSince != null ? { idleSince: record.idleSince } : {}),
        ...(record.recoveryRung ? { recoveryRung: record.recoveryRung } : {}),
        ...(record.recoveryCount ? { recoveryCount: record.recoveryCount } : {}),
        ...(record.recoveryAt != null ? { recoveryAt: record.recoveryAt } : {}),
        ...(record.placement
          ? { placement: record.placement, deviceId: record.placement.snapshot.computerId }
          : {}),
        ...(turn ? { turn } : {}),
      };
      this.execution.update(record.id, running);
    } else if (record.placement && this.columns().has("placement_json"))
      this.update(record.id, {
        placement: record.placement,
        deviceId: record.placement.snapshot.computerId,
      });
    this.projectChange(record.id);
  }

  /** An open or active row that already names this test, oldest first. */
  openByTestPath(testPath: string): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.readTable()} WHERE test_path = ? AND status IN ('open', 'active') ORDER BY created_at, seq LIMIT 1`,
      )
      .get(testPath) as Row | undefined;
    return row ? this.record(row) : undefined;
  }

  /** Apply a patch; only the named fields change, the task's own records with its row. */
  update(id: string, patch: TaskPatch): void {
    this.db.transaction(() => this.updateRows(id, patch))();
  }

  private updateRows(id: string, patch: TaskPatch): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    // The running work goes to its own row once the table exists (INF-1296 piece 3).
    const executing = this.execution.exists();
    const running: Partial<TaskExecution> = {};
    for (const [field, column] of Object.entries(PATCH_COLUMNS) as [PatchField, string][]) {
      if (!(field in patch)) continue;
      if (this.specifications.exists() && (field === "goal" || field === "prompt")) continue;
      if (executing && field in EXECUTION_COLUMNS) {
        (running as Record<string, unknown>)[field] = patch[field] ?? null;
        continue;
      }
      sets.push(`${column} = ?`);
      values.push(patch[field] ?? null);
    }
    if (
      this.specifications.exists() &&
      ("goal" in patch || "prompt" in patch || "intent" in patch)
    ) {
      this.specifications.revise(id, {
        ...("goal" in patch ? { goal: patch.goal ?? null } : {}),
        ...("prompt" in patch ? { prompt: patch.prompt ?? "" } : {}),
        ...("intent" in patch ? { intent: patch.intent ?? null } : {}),
      });
    }
    if ("intent" in patch && !this.specifications.exists()) {
      sets.push("intent_json = ?");
      values.push(patch.intent ? JSON.stringify(patch.intent) : null);
    }
    if ("shape" in patch) {
      this.assertReferencesKept(id, patch.shape);
      // A shape names the policy inputs it is read with, so its write replaces them.
      const split = this.policies.exists()
        ? splitPolicies(patch.shape)
        : { shape: patch.shape ?? null, row: undefined };
      if (split.row !== undefined) this.policies.set(id, split.row);
      if (this.shapes.exists())
        this.shapes.replace(id, split.shape ? JSON.parse(shapeJson(split.shape)!) : null);
      else {
        sets.push("shape_json = ?");
        values.push(shapeJson(split.shape));
      }
    }
    if ("gate" in patch) {
      const gate = patch.gate ?? null;
      sets.push("gate_kind = ?", "gate_ref = ?", "gate_until = ?", "gate_reason = ?");
      values.push(gate?.kind ?? null, gate?.ref ?? null, gate?.until ?? null, gate?.reason ?? null);
    }
    if ("delivery" in patch) {
      // A delivery names the current turn's declarations it is read with, so its write replaces them.
      // Each record is written again only when its saved value moves (INF-2220).
      const split = executing
        ? splitTurn(patch.delivery)
        : { delivery: patch.delivery ?? null, turn: undefined };
      if (split.turn !== undefined && this.turnMoves(id, split.turn)) running.turn = split.turn;
      // Its change evidence and permissions go to their own rows (INF-1296 piece 4).
      const history = this.delivery.exists()
        ? this.delivery.setDelivery(id, split.delivery)
        : split.delivery;
      const historyJson = history ? JSON.stringify(history) : null;
      if (this.specifications.exists()) {
        if (this.savedHistory(id) !== historyJson)
          prepared(
            this.db,
            `INSERT INTO task_record_history (task_id, delivery_json) VALUES (?, ?)
             ON CONFLICT(task_id) DO UPDATE SET delivery_json = excluded.delivery_json`,
          ).run(id, historyJson);
      } else {
        sets.push("delivery_json = ?");
        values.push(historyJson);
      }
    }
    if ("placement" in patch) {
      if (executing) running.placement = patch.placement ?? null;
      else {
        sets.push("placement_json = ?");
        values.push(patch.placement ? JSON.stringify(patch.placement) : null);
      }
    }
    if ("pendingSettle" in patch && this.delivery.exists()) {
      this.delivery.setPendingSettle(id, patch.pendingSettle ?? null);
    } else if ("pendingSettle" in patch) {
      sets.push("pending_settle_json = ?");
      values.push(patch.pendingSettle ? JSON.stringify(patch.pendingSettle) : null);
    }
    if (Object.keys(running).length > 0) this.execution.update(id, running);
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    // The change a task carries follows the facts that can move it (INF-1868 piece 1).
    if (CHANGE_PATCH_FIELDS.some((field) => field in patch)) this.projectChange(id);
  }

  /**
   * Whether saving this delivery would change any row it is saved in
   * (INF-2220): the turn's declarations, the history its column keeps, its
   * change evidence or its permissions. A write that moves none of them is
   * an exact no-op. A database from before those records is written whole,
   * as before.
   */
  deliveryMoves(id: string, delivery: TaskDelivery | null): boolean {
    if (!this.execution.exists() || !this.delivery.exists() || !this.specifications.exists())
      return true;
    const split = splitTurn(delivery);
    if (this.turnMoves(id, split.turn)) return true;
    const save = this.delivery.planDelivery(id, split.delivery);
    return (
      deliverySaveMoves(save) ||
      this.savedHistory(id) !== (save.history ? JSON.stringify(save.history) : null)
    );
  }

  /** Whether these declarations differ from the turn's saved ones, or the task has no execution row. */
  private turnMoves(id: string, turn: Record<string, unknown> | null): boolean {
    const saved = this.execution.turnJson(id);
    return saved === undefined || saved !== (turn ? JSON.stringify(turn) : null);
  }

  /** The history the delivery column keeps, exactly as saved; undefined with no history row. */
  private savedHistory(id: string): string | null | undefined {
    const row = prepared(
      this.db,
      "SELECT delivery_json FROM task_record_history WHERE task_id = ?",
    ).get(id) as { delivery_json: string | null } | undefined;
    return row ? row.delivery_json : undefined;
  }

  pendingPlacements(): TaskRecord[] {
    if (this.execution.exists()) return this.getMany(this.execution.pendingPlacementIds());
    return this.read(
      this.db
        .prepare(
          `SELECT * FROM ${this.readTable()} WHERE json_extract(placement_json, '$.reservation') = 'pending'`,
        )
        .all() as Row[],
    );
  }

  /** Existence does not compose specifications, delivery or execution records. */
  has(id: string): boolean {
    return prepared(this.db, "SELECT 1 FROM tasks WHERE id = ?").get(id) !== undefined;
  }

  get(id: string): TaskRecord | undefined {
    if (this.projection?.records.has(id)) return this.projection.records.get(id);
    const row = prepared(this.db, `SELECT * FROM ${this.readTable()} WHERE id = ?`).get(id) as
      | Row
      | undefined;
    const record = row ? this.record(row) : undefined;
    this.projection?.records.set(id, record);
    return record;
  }

  /** Coverage needs only task-row facts, never shape, delivery or execution payloads. */
  coverageFields(id: string): TaskCoverageFields | undefined {
    if (this.projection?.records.has(id)) return this.projection.records.get(id);
    if (this.projection?.coverage.has(id)) return this.projection.coverage.get(id);
    const row = prepared(
      this.db,
      `SELECT id, key, title, status, closed_reason, created_at, started_at FROM tasks WHERE id = ?`,
    ).get(id) as
      | Pick<Row, "id" | "key" | "title" | "status" | "closed_reason" | "created_at" | "started_at">
      | undefined;
    const fields = row
      ? {
          id: row.id,
          key: row.key ?? "",
          title: row.title,
          status: row.status,
          closedReason: row.closed_reason,
          createdAt: row.created_at,
          startedAt: row.started_at,
        }
      : undefined;
    this.projection?.coverage.set(id, fields);
    return fields;
  }

  /** Direct child identities in the same order as listChildren, without their payloads. */
  childIds(parentId: string): string[] {
    const rows = prepared(this.db, "SELECT id, created_at, seq FROM tasks WHERE parent_id = ?").all(
      parentId,
    ) as Pick<Row, "id" | "created_at" | "seq">[];
    return rows
      .sort((a, b) => a.created_at - b.created_at || (a.seq ?? 0) - (b.seq ?? 0))
      .map((row) => row.id);
  }

  byKey(key: string): TaskRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${this.readTable()} WHERE key = ?`)
      .get(key.toUpperCase()) as Row | undefined;
    return row ? this.record(row) : undefined;
  }

  list(): TaskRecord[] {
    return oldestFirst(
      this.read(prepared(this.db, `SELECT * FROM ${this.readTable()}`).all() as Row[]),
    );
  }

  listByStatus(...statuses: TaskStatus[]): TaskRecord[] {
    if (statuses.length === 0) return [];
    const key = JSON.stringify(statuses);
    const known = this.projection?.lists.get(key);
    if (known) return known;
    const marks = statuses.map(() => "?").join(", ");
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE status IN (${marks})`,
    ).all(...statuses) as Row[];
    const records = oldestFirst(this.read(rows));
    this.projection?.lists.set(key, records);
    return records;
  }

  /**
   * The live set and every row closed at or after `since`, oldest first:
   * what the board shows, read without decoding the closed rows before it
   * (a long record is mostly those).
   */
  listLiveOrClosedSince(since: number): TaskRecord[] {
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE status IN ('open', 'active') OR closed_at >= ?`,
    ).all(since) as Row[];
    return oldestFirst(this.read(rows));
  }

  /**
   * Each closed row's status, kind, close time and the fields a search
   * matches on, oldest first, without reading the rest of the row
   * (`TaskProtocol.search`).
   */
  listClosedSearchFields(): TaskSearchFields[] {
    const rows = prepared(
      this.db,
      `SELECT id, key, kind, status, title, goal, closed_at FROM ${this.readTable()}
       WHERE status NOT IN ('open', 'active') ORDER BY created_at, seq`,
    ).all() as Pick<Row, "id" | "key" | "kind" | "status" | "title" | "goal" | "closed_at">[];
    return rows.map((row) => ({
      id: row.id,
      key: row.key ?? "",
      kind: row.kind,
      status: row.status,
      title: row.title,
      goal: row.goal,
      closedAt: row.closed_at,
    }));
  }

  /**
   * Every row holding a computer move, open or closed, oldest first, sought
   * through `task_placement_requests_computer_move` without reading the rows
   * that hold none: the ready sweep asks each minute, and a long record is
   * mostly closed rows (docs/testing.md, "The scale check").
   */
  listWithComputerMove(): TaskRecord[] {
    if (!this.shapes.exists()) return this.list().filter((record) => record.shape?.computer_move);
    const ids = prepared(
      this.db,
      "SELECT task_id FROM task_placement_requests WHERE json_type(value_json, '$.computer_move') = 'object'",
    )
      .pluck()
      .all() as string[];
    return this.getMany(ids);
  }

  /** Recorded overrides on this computer, without composing task records or their history.
   * Closed tasks remain eligible: their declared process groups can still be alive.
   * CROSS JOIN keeps the sparse override index first, not a walk of execution history.
   */
  passingOverridesForComputer(computerId: string, kind: OverridableHold): string[] {
    const rows = prepared(
      this.db,
      `SELECT p.task_id, p.override_json, d.head_sha
       FROM task_permissions p
       CROSS JOIN task_execution e ON e.task_id = p.task_id
       LEFT JOIN task_delivery_evidence d ON d.task_id = p.task_id
       WHERE p.override_json IS NOT NULL AND e.device_id = ?`,
    ).all(computerId) as { task_id: string; override_json: string; head_sha: string | null }[];
    return rows
      .filter((row) =>
        overridePasses(
          { override: parseJson<HoldOverride>(row.override_json) ?? undefined },
          kind,
          row.head_sha ?? undefined,
        ),
      )
      .map((row) => row.task_id);
  }

  /**
   * How many active rows each computer that runs work holds, by its device
   * id, read from `task_execution` without composing a record: Settings ->
   * Devices counts them again after every task write (`Computers.list`).
   * CROSS JOIN keeps the status index first, never a walk of execution rows.
   */
  countActiveByDevice(): Map<string, number> {
    const devices = this.execution.exists()
      ? (prepared(
          this.db,
          `SELECT x.device_id FROM tasks t CROSS JOIN task_execution x ON x.task_id = t.id
           WHERE t.status = 'active' AND x.device_id IS NOT NULL`,
        )
          .pluck()
          .all() as string[])
      : this.listByStatus("active").flatMap((record) => record.deviceId ?? []);
    const counts = new Map<string, number>();
    for (const device of devices) counts.set(device, (counts.get(device) ?? 0) + 1);
    return counts;
  }

  /** Whether any row holds this status, answered without reading or composing one. */
  hasStatus(status: TaskStatus): boolean {
    return (
      prepared(this.db, "SELECT 1 FROM tasks WHERE status = ? LIMIT 1").get(status) !== undefined
    );
  }

  /** Whether any row is of this kind, answered without reading or composing one. */
  hasKind(kind: TaskKind): boolean {
    return prepared(this.db, "SELECT 1 FROM tasks WHERE kind = ? LIMIT 1").get(kind) !== undefined;
  }

  /**
   * Whether a row closed done that is not an `operation`, a `question`
   * counting only when a message of the captain's is attached to it,
   * answered without reading or composing one (`TaskService.hasFinishedTask`).
   */
  hasFinishedTask(): boolean {
    return (
      prepared(
        this.db,
        `SELECT 1 FROM tasks t
         WHERE t.status = 'done' AND t.kind <> 'operation'
           AND (t.kind <> 'question'
             OR EXISTS (SELECT 1 FROM captain_asks a WHERE a.task_id = t.id))
         LIMIT 1`,
      ).get() !== undefined
    );
  }

  /**
   * How many `work` rows a crewmate started closed done, counted up to
   * `upTo` without reading them (`TaskService.finishedCrewmates`).
   */
  countFinishedCrewmates(upTo: number): number {
    const row = prepared(
      this.db,
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM tasks
         WHERE kind = 'work' AND status = 'done' AND started_at IS NOT NULL
         LIMIT ?
       )`,
    ).get(upTo) as { n: number };
    return row.n;
  }

  /** How many rows of this kind hold this status, counted without reading them. */
  count(status: TaskStatus, kind: TaskKind): number {
    const row = prepared(
      this.db,
      "SELECT COUNT(*) AS n FROM tasks WHERE status = ? AND kind = ?",
    ).get(status, kind) as { n: number };
    return row.n;
  }

  /** These rows, oldest first; an unknown id reads as nothing. */
  getMany(ids: readonly string[]): TaskRecord[] {
    if (ids.length === 0) return [];
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids)) as Row[];
    return oldestFirst(this.read(rows));
  }

  /** Only active rows among these ids; graph readers keep their own edge order. */
  getActiveMany(ids: readonly string[]): TaskRecord[] {
    if (ids.length === 0) return [];
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active'`,
    ).all(JSON.stringify(ids)) as Row[];
    return this.read(rows);
  }

  /**
   * The rows among these ids whose status is one of these, unordered; a row in
   * any other status is never composed (INF-2342). Inside a projection a row it
   * already holds answers by that row's status, as `get` would.
   */
  getAmong(ids: readonly string[], statuses: readonly TaskStatus[]): TaskRecord[] {
    const known = this.projection?.records;
    const held = known ? ids.filter((id) => known.has(id)) : [];
    const unread = known ? ids.filter((id) => !known.has(id)) : ids;
    const found = held.flatMap((id) => {
      const record = known?.get(id);
      return record && statuses.includes(record.status) ? [record] : [];
    });
    if (unread.length === 0 || statuses.length === 0) return found;
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE id IN (SELECT value FROM json_each(?)) AND status IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(unread), JSON.stringify(statuses)) as Row[];
    return [...found, ...this.read(rows)];
  }

  /** How many children each of these parents has, and how many of them closed. */
  childCounts(parentIds: readonly string[]): Map<string, { total: number; closed: number }> {
    const counts = new Map<string, { total: number; closed: number }>();
    if (parentIds.length === 0) return counts;
    const rows = prepared(
      this.db,
      `SELECT parent_id, COUNT(*) AS total,
              SUM(status NOT IN ('open', 'active')) AS closed
       FROM tasks WHERE parent_id IN (SELECT value FROM json_each(?))
       GROUP BY parent_id`,
    ).all(JSON.stringify(parentIds)) as { parent_id: string; total: number; closed: number }[];
    for (const row of rows) counts.set(row.parent_id, { total: row.total, closed: row.closed });
    return counts;
  }

  /** Earliest child creation or start after a request, without composing child records. */
  firstChildActivityAfter(parentId: string, since: number): number | undefined {
    const row = prepared(
      this.db,
      `SELECT MIN(at) AS at FROM (
        SELECT created_at AS at FROM ${this.readTable()} WHERE parent_id = ? AND created_at > ?
        UNION ALL
        SELECT started_at AS at FROM ${this.readTable()} WHERE parent_id = ? AND started_at > ?
      )`,
    ).get(parentId, since, parentId, since) as { at: number | null };
    return row.at ?? undefined;
  }

  /** Live children for review witnesses; closed children's payloads are not read. */
  listLiveChildren(parentId: string): TaskRecord[] {
    const key = `live-children:${parentId}`;
    const known = this.projection?.lists.get(key);
    if (known) return known;
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE parent_id = ? AND status IN ('open', 'active')`,
    ).all(parentId) as Row[];
    const records = oldestFirst(this.read(rows));
    this.projection?.lists.set(key, records);
    return records;
  }

  /** A parent's direct children, oldest first. */
  listChildren(parentId: string): TaskRecord[] {
    const key = `children:${parentId}`;
    const known = this.projection?.lists.get(key);
    if (known) return known;
    const rows = prepared(this.db, `SELECT * FROM ${this.readTable()} WHERE parent_id = ?`).all(
      parentId,
    ) as Row[];
    const records = oldestFirst(this.read(rows));
    this.projection?.lists.set(key, records);
    return records;
  }

  /**
   * Every descendant, deepest last (a recursive walk down parent_id). The
   * CROSS JOIN keeps SQLite reading the tree first and seeking each record,
   * where it would otherwise walk every task to match the tree.
   */
  listDescendants(id: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 1 FROM tasks WHERE parent_id = ?
           UNION ALL
           SELECT t.id, tree.depth + 1 FROM tasks t JOIN tree ON t.parent_id = tree.id
           WHERE tree.depth < 64
         )
         SELECT records.* FROM tree CROSS JOIN ${this.readTable()} records ON records.id = tree.id
         ORDER BY tree.depth, records.created_at, records.seq`,
      )
      .all(id) as Row[];
    return this.read(rows);
  }

  /**
   * The ready query (task-system design section 7): open work, unheld,
   * dispatch-on-ready, with no `blocks` edge from a task that has not
   * closed successfully (done clears; open, active and dropped do not).
   * Priority first, then age.
   */
  listReady(): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM ${this.readTable()} t
         WHERE t.status = 'open' AND t.kind = 'work'
           AND t.gate_kind IS NULL AND t.start_policy = 'when-ready'
           AND NOT EXISTS (
             SELECT 1 FROM task_links l JOIN tasks b ON b.id = l.from_id
             WHERE l.to_id = t.id AND l.type = 'blocks'
               AND b.status <> 'done')
         ORDER BY t.priority, t.created_at, t.seq`,
      )
      .all() as Row[];
    return this.read(rows);
  }

  /**
   * Open, unheld work whose wait can never end: a `blocks` edge from a
   * dropped task. The ready sweep turns each into one decision card.
   */
  listDeadBlocked(): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.* FROM ${this.readTable()} t
         JOIN task_links l ON l.to_id = t.id AND l.type = 'blocks'
         JOIN tasks b ON b.id = l.from_id
         WHERE t.status = 'open' AND t.kind = 'work' AND t.gate_kind IS NULL
           AND b.status = 'dropped'
         ORDER BY t.priority, t.created_at, t.seq`,
      )
      .all() as Row[];
    return this.read(rows);
  }

  /** Rows missing the record invariants TaskService enforces (boot check). */
  countMissingInvariants(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE key IS NULL OR project_id IS NULL OR updated_at IS NULL",
      )
      .get() as { n: number };
    return row.n;
  }

  /** The board sequence of the last committed mutation (0 on a fresh database). */
  boardSeq(): number {
    const row = this.db.prepare("SELECT seq FROM task_board WHERE id = 1").get() as
      | { seq: number }
      | undefined;
    return row?.seq ?? 0;
  }

  /** Move the board sequence on by one inside the committing write, and read it. */
  bumpBoardSeq(): number {
    const row = this.db
      .prepare("UPDATE task_board SET seq = seq + 1 WHERE id = 1 RETURNING seq")
      .get() as { seq: number } | undefined;
    if (!row) throw new Error("task_board row missing; migration 20 did not run.");
    return row.seq;
  }

  /** Hard delete: a spawn that never ran, or the D-13 purge. */
  delete(id: string): void {
    this.changes.deleteFor(id);
    this.delivery.deleteFor(id);
    this.execution.deleteFor(id);
    this.policies.deleteFor(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  deleteAll(): number {
    this.changes.deleteAll();
    this.delivery.deleteAll();
    this.execution.deleteAll();
    this.policies.deleteAll();
    return this.db.prepare("DELETE FROM tasks").run().changes;
  }
}
