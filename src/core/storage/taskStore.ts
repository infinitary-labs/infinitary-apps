import type {
  CheckRepairLedger,
  MergeRepairDeclaration,
  MergeRepairImpact,
} from "@shared/checkRepair";
import { type HoldOverride, overridePasses } from "@shared/holds";
import type { LiveValidation } from "@shared/liveValidation";
import type { MergeReview } from "@shared/mergeReview";
import type { CommittedPlacement } from "@shared/placement";
import type { CaptainAction, RequiredActionOffer } from "@shared/requiredActions";
import type { ReviewRisk, ReviewVerdict } from "@shared/rigor";
import type { RiskAssessment } from "@shared/risk";
import type { WorkShape } from "@shared/routingPolicy";
import type { EffectiveTaskPolicies } from "@shared/taskPolicies";
import type { RunChecks, TaskDeliveryMode } from "@shared/tasks";
import type { WriteAsk } from "@shared/writeAsk";
import type { SpawnIntent } from "../orchestrator/intentBrief";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

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
  actor: "captain" | "firstmate";
  requestedAt: number;
  proceedWithOpen: boolean;
};

/**
 * The unversioned kept click of contract 4.66 (`TaskDelivery.mergeOrder`):
 * it names no approved head, so it is never carried forward - the boot
 * retires it and says so (FI3-304: no upgrade without a provable baseline).
 */
export type MergeOrder = { at: number; proceedWithOpen: boolean };

/**
 * A completion card the host published after its checks passed, and the
 * head those checks read: the baseline a click on that exact offer
 * approves. A card without one (seeded, or a Firstmate card) approves no head.
 */
export type CompletionOffer = {
  cardId: string;
  offerId: string;
  headSha: string;
  prNumber: number;
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
  /** A reviewed task's review has not passed for this change. */
  | "review"
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
  | "guidance";

/**
 * The captain's merge approval (FI3-304), version 1: minted by his click on
 * a completion offer the host published at a known head, in the same
 * transaction as the card's resolution. It covers that pull request, that
 * head and the repairs the host accepted after it, and it
 * stands through conflicts, waits and restarts until it is consumed by the
 * merge, revoked (an interruption, his withdrawal), invalidated (the work
 * changed, the pull request or project is no longer the one approved) or
 * superseded (a new completion card or a new click). `generation` advances
 * on every one of those, so a run that started earlier can tell before it
 * sends anything.
 */
export type MergeAuthorization = {
  version: 1;
  id: string;
  generation: number;
  issuer: "captain";
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
  /** The head the captain approved: the one the completion card's checks read. */
  approvedHead: string;
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
};

/** Delivery facts, as they become known (check_pr_ci, land, merge-pr, review). */
export type TaskDelivery = {
  /** Versioned public story and native-upload receipts; only TaskService writes them. */
  presentation?: import("@shared/changePresentation").ChangePresentationRecord;
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
  /** The PR head the last CI read saw, or the assigned commit on an independent review task. */
  headSha?: string;
  ci?: "green" | "red" | "pending" | "no-pr" | "merged";
  ciAt?: number;
  /** When the host says the first check on that head started (INF-587). */
  ciStartedAt?: number;
  /** When the checks finished: the last finish when green, the first failure's when red. */
  ciFinishedAt?: number;
  /** The newest watched run's state and host times, kept after its watch ends (INF-594). */
  runChecks?: RunChecks;
  landedMode?: "fast-forward" | "merge" | "pr";
  landedAt?: number;
  /**
   * The independent review's latest verdict on a reviewed task (delivery
   * rigor phase 2), recorded on the BUILDER: the verdict, the head the
   * reviewer read, and the risk it named beside CI (never a hold, Q4). The
   * review that recorded it is read off the parent edge
   * (`TaskService.verdictReviewOf`), never cached here.
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
   * The round counters and caps (delivery rigor phase 3), on the BUILDER:
   * `ciRounds` counts unsuccessful declared own repairs (`ciRedHead` is the
   * last failed repair head), `reviewRounds` the findings verdicts; `ciCapAt` / `reviewCapAt`
   * are set when the cap was reached and hold until the steer that reopens
   * the rounds clears them; `capAnsweredAt` records the captain's answer to
   * a Firstmate decision card on the task since the cap - the answer the
   * reopening steer needs.
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
   * Reviewed pull requests a `request_merge` card may name (FI3-1543).
   * A referenced one is not this task's pull request and is never written
   * as `prNumber`.
   */
  mergeReviews?: MergeReview[];
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
   * The risk assessment on the newest completion card the host published
   * (docs/card-authoring.md "The risk chart"): its crewmate's levels and
   * lines alone. A new completion card
   * replaces it.
   */
  risk?: RiskAssessment;
  /**
   * The host's last refusal of this task's completion card, present until
   * a completion card goes up (docs/card-authoring.md, "A refused
   * completion card"): what the report wake and `crew_status` say beside
   * a report that claims the card went up.
   */
  cardRefusal?: CardRefusal;
  /**
   * What the crewmate's latest report declared about whose turn follows it
   * (FI3-435): it waits on the captain (`captainWait`, which places the
   * task's `captain` gate), or its work is finished and the captain has
   * read it (`finishedAt`). Present from that report until its next turn
   * starts - a close, a click, a reply or a steer all start one.
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
};

/** A wait on the captain a crewmate declared in its report: why, and the card he is to read. */
export type CaptainWait = { at: number; reason: string; cardId?: string };

/** A crewmate's request that the Firstmate act: when its report asked, and what. */
export type FirstmateAsk = { at: number; request: string };

/**
 * Why the host refused a completion card: its checks had not passed, the
 * CI cap holds it, its review has not passed, its shape failed the card
 * lint, or anything else the emit refused (its size, id or pictures) -
 * `why` carries the host's own words for each.
 */
export type CardRefusalReason = "checks" | "ci-cap" | "review" | "shape" | "other";

/** One refused completion card: the title it was emitted with, when, and why. */
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

/**
 * A round cap that stands on a builder: placed (`ciCapAt` / `reviewCapAt`)
 * and not yet answered (`capAnsweredAt`), excluding first-mate review holds.
 * It is what places the builder's
 * `captain` gate when no card is up (docs/delivery-rigor.md, "The caps"):
 * `reason` is the gate's, `head` its ref - the head the cap was reached at.
 */
export type StandingCap = { held: "ci-cap" | "review-cap"; reason: string; head?: string };

export function standingCap(delivery: TaskDelivery | null | undefined): StandingCap | undefined {
  // The captain's override on the repair or re-review limit lifts that cap.
  const ciAt = overridePasses(delivery, "repairs", delivery?.headSha)
    ? undefined
    : delivery?.ciCapAt;
  const reviewAt =
    delivery?.reviewCapOwner === "firstmate" ||
    overridePasses(delivery, "rounds", delivery?.headSha)
      ? undefined
      : delivery?.reviewCapAt;
  if (!delivery || (ciAt === undefined && reviewAt === undefined)) return undefined;
  const capAt = Math.max(ciAt ?? 0, reviewAt ?? 0);
  if (delivery.capAnsweredAt !== undefined && delivery.capAnsweredAt >= capAt) return undefined;
  if (ciAt !== undefined && ciAt >= (reviewAt ?? 0)) {
    const head = delivery.ciRedHead ?? delivery.headSha;
    return { held: "ci-cap", reason: "the CI cap", ...(head ? { head } : {}) };
  }
  const head = delivery.reviewRoundSha ?? delivery.reviewSha ?? delivery.headSha;
  return { held: "review-cap", reason: "the review cap", ...(head ? { head } : {}) };
}

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
};

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
 * read (`TaskService.basisHolds`) and never stored: a stamp goes stale the
 * moment the basis answers.
 */
function shapeJson(shape: WorkShape | null | undefined): string | null {
  if (!shape) return null;
  const { basis_verified: _derived, ...recorded } = shape;
  return JSON.stringify(recorded);
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
    shape: parseJson<WorkShape>(row.shape_json),
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
    delivery: parseJson<TaskDelivery>(row.delivery_json),
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

export class TaskStore {
  private taskColumns: Set<string> | undefined;

  constructor(private readonly db: AppDatabase) {}

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
    const here = this.columns().has("device_id") ? " AND device_id IS NULL" : "";
    this.db
      .prepare(
        `UPDATE tasks SET activity = 'interrupted', updated_at = ? WHERE status = 'active' AND activity IN ('running', 'starting')${here}`,
      )
      .run(now);
  }

  insert(record: TaskRecord): void {
    const filing = this.columns().has("test_path");
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
        record.sessionFile,
        record.accountId,
        record.difficulty,
        shapeJson(record.shape),
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
        record.delivery ? JSON.stringify(record.delivery) : null,
        record.pendingSettle ? JSON.stringify(record.pendingSettle) : null,
        record.assignee,
        record.model,
        record.createdAt,
        record.updatedAt,
        record.startedAt,
        record.closedAt,
        record.idleSince ?? null,
        record.recoveryRung ?? 0,
        record.recoveryCount ?? 0,
        record.recoveryAt ?? null,
        ...(filing
          ? [record.testPath ?? null, record.captainOpenedAt ?? null, record.verdict ?? null]
          : []),
      );
    if (record.placement && this.columns().has("placement_json"))
      this.update(record.id, {
        placement: record.placement,
        deviceId: record.placement.snapshot.computerId,
      });
  }

  /** An open or active row that already names this test, oldest first. */
  openByTestPath(testPath: string): TaskRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE test_path = ? AND status IN ('open', 'active') ORDER BY created_at, seq LIMIT 1",
      )
      .get(testPath) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Apply a patch; only the named fields change. */
  update(id: string, patch: TaskPatch): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(PATCH_COLUMNS) as [PatchField, string][]) {
      if (!(field in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[field] ?? null);
    }
    if ("intent" in patch) {
      sets.push("intent_json = ?");
      values.push(patch.intent ? JSON.stringify(patch.intent) : null);
    }
    if ("shape" in patch) {
      sets.push("shape_json = ?");
      values.push(shapeJson(patch.shape));
    }
    if ("gate" in patch) {
      const gate = patch.gate ?? null;
      sets.push("gate_kind = ?", "gate_ref = ?", "gate_until = ?", "gate_reason = ?");
      values.push(gate?.kind ?? null, gate?.ref ?? null, gate?.until ?? null, gate?.reason ?? null);
    }
    if ("delivery" in patch) {
      sets.push("delivery_json = ?");
      values.push(patch.delivery ? JSON.stringify(patch.delivery) : null);
    }
    if ("placement" in patch) {
      sets.push("placement_json = ?");
      values.push(patch.placement ? JSON.stringify(patch.placement) : null);
    }
    if ("pendingSettle" in patch) {
      sets.push("pending_settle_json = ?");
      values.push(patch.pendingSettle ? JSON.stringify(patch.pendingSettle) : null);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  pendingPlacements(): TaskRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE json_extract(placement_json, '$.reservation') = 'pending'",
        )
        .all() as Row[]
    ).map(fromRow);
  }

  get(id: string): TaskRecord | undefined {
    const row = prepared(this.db, "SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  byKey(key: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key.toUpperCase()) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): TaskRecord[] {
    const rows = prepared(this.db, "SELECT * FROM tasks ORDER BY created_at, seq").all() as Row[];
    return rows.map(fromRow);
  }

  listByStatus(...statuses: TaskStatus[]): TaskRecord[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    const rows = prepared(
      this.db,
      `SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY created_at, seq`,
    ).all(...statuses) as Row[];
    return rows.map(fromRow);
  }

  /**
   * The live set and every row closed at or after `since`, oldest first:
   * what the board shows, read without decoding the closed rows before it
   * (a long record is mostly those).
   */
  listLiveOrClosedSince(since: number): TaskRecord[] {
    const rows = prepared(
      this.db,
      `SELECT * FROM tasks WHERE status IN ('open', 'active') OR closed_at >= ?
       ORDER BY created_at, seq`,
    ).all(since) as Row[];
    return rows.map(fromRow);
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
      `SELECT * FROM tasks WHERE id IN (SELECT value FROM json_each(?))
       ORDER BY created_at, seq`,
    ).all(JSON.stringify(ids)) as Row[];
    return rows.map(fromRow);
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

  /** A parent's direct children, oldest first. */
  listChildren(parentId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, seq")
      .all(parentId) as Row[];
    return rows.map(fromRow);
  }

  /** Every descendant, deepest last (a recursive walk down parent_id). */
  listDescendants(id: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 1 FROM tasks WHERE parent_id = ?
           UNION ALL
           SELECT t.id, tree.depth + 1 FROM tasks t JOIN tree ON t.parent_id = tree.id
           WHERE tree.depth < 64
         )
         SELECT tasks.* FROM tasks JOIN tree ON tasks.id = tree.id
         ORDER BY tree.depth, tasks.created_at, tasks.seq`,
      )
      .all(id) as Row[];
    return rows.map(fromRow);
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
        `SELECT t.* FROM tasks t
         WHERE t.status = 'open' AND t.kind = 'work'
           AND t.gate_kind IS NULL AND t.start_policy = 'when-ready'
           AND NOT EXISTS (
             SELECT 1 FROM task_links l JOIN tasks b ON b.id = l.from_id
             WHERE l.to_id = t.id AND l.type = 'blocks'
               AND b.status <> 'done')
         ORDER BY t.priority, t.created_at, t.seq`,
      )
      .all() as Row[];
    return rows.map(fromRow);
  }

  /**
   * Open, unheld work whose wait can never end: a `blocks` edge from a
   * dropped task. The ready sweep turns each into one decision card.
   */
  listDeadBlocked(): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.* FROM tasks t
         JOIN task_links l ON l.to_id = t.id AND l.type = 'blocks'
         JOIN tasks b ON b.id = l.from_id
         WHERE t.status = 'open' AND t.kind = 'work' AND t.gate_kind IS NULL
           AND b.status = 'dropped'
         ORDER BY t.priority, t.created_at, t.seq`,
      )
      .all() as Row[];
    return rows.map(fromRow);
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

  /** Hard delete: a spawn that never ran, or the D-13 purge. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  deleteAll(): number {
    return this.db.prepare("DELETE FROM tasks").run().changes;
  }
}
