import { createHash, randomUUID } from "node:crypto";
import type { AttachmentRef } from "@shared/attachments";
import type {
  CardAnswer,
  CardDecisionContext,
  DropTaskReview,
  OpenEffect,
  TaskLifecycleOp,
} from "@shared/cards";
import type { ChangeRecord } from "@shared/change";
import type { ChangePresentationRecord } from "@shared/changePresentation";
import { isRepairAssessment } from "@shared/checkRepair";
import { reportSummary } from "@shared/feed";
import { fixedHoldWords, overridePasses } from "@shared/holds";
import type { LastTurn, LastTurnReply } from "@shared/lastTurn";
import type { KeptValidationInput } from "@shared/liveValidation";
import type { ReasoningChoice } from "@shared/modelSlots";
import {
  type CommittedPlacement,
  type ComputerMove,
  PLACEMENT_WAIT,
  type PlacementRequirements,
  type PlacementSnapshot,
  type PlacementWait,
  placementReason,
  placementRequirementsSchema,
  placementSnapshotSchema,
} from "@shared/placement";
import type { TypedFailure } from "@shared/plainProblem";
import {
  type DecisionRecord,
  type InterruptEventData,
  type SteerEventData,
  TASK_CARD_VIA,
} from "@shared/provenance";
import type { IntelligenceBucket } from "@shared/quota";
import { type Reasoning, reasoningWord } from "@shared/reasoning";
import {
  DROP_BEFORE_START,
  DROP_REVIEW_STALE,
  dropIneligibleRefusal,
  dropMissingRefusal,
  dropPartsRefusal,
  dropReviewKeys,
  NO_LONGER_WANTED,
  sameDropReview,
} from "@shared/recordDrop";
import { type KeptRecoveryWay, recoveryWay, type WorkWait } from "@shared/recovery";
import { deliveryForRecord, type RepoView } from "@shared/repos";
import {
  type CaptainAction,
  captainActionResult,
  type RequiredAction,
  type RequiredActionOffer,
} from "@shared/requiredActions";
import { type HostStamp, stampOnto, type WorkShape } from "@shared/routingPolicy";
import type { PlanItem } from "@shared/taskPlan";
import {
  effectiveTaskPolicies,
  POLICY_CARE_BOUND,
  POLICY_DELIVERY_WORDS,
  POLICY_MERGING_WORDS,
  POLICY_SOURCE_WORDS,
  type PolicyRepo,
  type TaskPolicyEdits,
} from "@shared/taskPolicies";
import {
  QUEUE_POLICY,
  QUEUED_ACTIVITY,
  queueClosedRefusal,
  queueMissingRefusal,
  queuePartsRefusal,
  queueStartedRefusal,
  UNQUEUED_ACTIVITY,
} from "@shared/taskQueue";
import { type FirstReleaseReport, firstReleaseReportSchema } from "@shared/taskRelease";
import type { DropEffects } from "@shared/tasks";
import { isUnstartedWork } from "@shared/tasks";
import { CARE_WORDS } from "@shared/vocabulary";
import type { HandoverFile } from "@shared/work";
import {
  NEVER_SENT_AGAIN,
  WRITE_ASK_CAP,
  type WriteAsk,
  type WriteAskOutcome,
} from "@shared/writeAsk";
import { redactObserveText } from "../observe/redact";
import {
  type AskDelivery,
  type DeliveryEntry,
  type DeliveryFacts,
  JUDGEABLE_DELIVERY,
} from "../orchestrator/answerDelivery";
import { amendBriefGoal, type BriefPart, type SpawnIntent } from "../orchestrator/intentBrief";
import { capWithOverflow, MESSAGE_EXCERPT_LIMIT, type MessageFile } from "../overflow";
import { KIND_SOURCE } from "../routing/kindClassifier";
import { tierFor } from "../routing/policy";
import {
  type AskAttachedVia,
  type AskImage,
  type AskRecord,
  AskStore,
  type AskTurnState,
} from "../storage/askStore";
import { isHostRaisedShape } from "../storage/changeStore";
import type { AppDatabase } from "../storage/db";
import { type ProjectRecord, ProjectStore } from "../storage/projectStore";
import { sessionFilesIn } from "../storage/sessionReader";
import {
  HISTORY_FIELDS,
  PERMISSION_COLUMNS,
  type PermissionField,
} from "../storage/taskDeliveryFields";
import {
  type ConcernedTaskEvent,
  type InsertTaskEvent,
  type TaskConcern,
  type TaskConcernRelation,
  type TaskEvent,
  type TaskEventActor,
  TaskEventStore,
} from "../storage/taskEventStore";
import { TURN_DECLARATION_FIELDS } from "../storage/taskExecutionStore";
import { type TaskLink, TaskLinkStore, type TaskLinkType } from "../storage/taskLinkStore";
import {
  REFERENCE_SHAPE_FIELDS,
  TASK_REFERENCE_KINDS,
  type TaskReference,
  type TaskReferenceKind,
  type TaskReferenceStore,
} from "../storage/taskReferenceStore";
import { conversationOf, type TaskSession, TaskSessionStore } from "../storage/taskSessionStore";
import {
  type CardRefusal,
  type PendingSettleIntent,
  type TaskActivity,
  type TaskClosedReason,
  type TaskDelivery,
  type TaskGate,
  type TaskKind,
  type TaskRecord,
  type TaskSearchFields,
  type TaskStartPolicy,
  type TaskStatus,
  TaskStore,
} from "../storage/taskStore";
import { compactBrief, expandBrief, reportHash } from "./briefReceipt";
import { baselineStands } from "./dependencyWaits";
import { holdingWaits, holdKindOf } from "./holdingWaits";
import { decideValidation, recordValidation } from "./liveValidation";
import { latestResultOf, type ReportEntry, reportEntryOf, type TaskResult } from "./reportEntry";
import type { TaskExportBundle } from "./taskExport";
import { referenceRefusal, type TaskRelationship } from "./taskRelationships";
import { liveWaitCycle, waitCycleWords } from "./waitCycles";

/**
 * The one task writer (task-system design principle 2: one writer, one
 * transaction, one event). Every state change commits together with the
 * timeline event that explains it; nothing else in the app writes the
 * tasks, task_events or task_links tables. Records are never deleted by
 * success - settling closes them (captain decision D2) - and the only hard
 * deletes are a spawn that never ran and the D-13 purge.
 *
 * P0 scope: the record, keys, transitions, outcome/delivery/activity, and
 * the `blocks` edge that carries the old after-task wait. P1 adds the
 * capture side (design section 6): `captain_asks` rows opened per turn and
 * attached to tasks with the `ask` event in the same transaction, plus the
 * question / decision / operation kinds the attaching paths file. P2 adds
 * the graph (design sections 7 to 9): one parent per task with the
 * ancestor walk refusing cycles and children inheriting the project;
 * `blocks` edges refused at insert when they would close a cycle; the
 * ready query the R1 sweep runs; the parent close rule; and the crewmate
 * side (`fileFollowup`, `noteProgress`). P3 adds the change seam the wire
 * protocol rides: every write goes through `write()`, whose OUTERMOST
 * transaction bumps the board sequence (`task_board.seq`, migration 20) in
 * the same commit and, only after that commit, hands the change - seq,
 * touched task ids, inserted events - to `onChange` listeners. The core
 * builds the `inf:tasks` snapshot and the `task_changed` / `task_event`
 * FmEvents from that seam and from SQLite, never from memory (design
 * section 9: commit, then emit).
 *
 * Refusals the agent should read as tool text - a cycle, a parent with
 * open children, a move a workspace forbids - are `TaskGraphRefusal`
 * errors; a plain Error is a programming fault or an unknown id.
 */

/**
 * A timeline targets at most this many events (design section 5). Past it
 * the oldest fold into one `compacted` event down to TIMELINE_KEEP rows,
 * so the fold runs once per hundred events rather than on every write;
 * a fold that meets an earlier `compacted` row absorbs its counts, so the
 * head of a long timeline always says how much it stands for. Counts are
 * folded, never content summarized (design section 2.4: no memory decay).
 * Prospective provenance is exempt, so a provenance-heavy timeline may
 * exceed the target rather than discard its evidence, and so is every
 * event another task's Activity reads (docs/task-record.md, "Whom an event
 * concerns"), and so is every event whose data marks it `journal: true`,
 * a record a replay reads back (docs/programs.md, "The journal and replay").
 */
export const TIMELINE_CAP = 500;
export const TIMELINE_KEEP = 400;

// Specification and receipt evidence must remain retrievable verbatim.
const COMPACTION_EXEMPT_KINDS = [
  "decided",
  "steered",
  "interrupted",
  "report",
  "card_resolved",
  "briefed",
] as const;

/** What a `compacted` event carries in `data`. */
export type CompactedEventData = {
  folded: number;
  firstAt: number;
  lastAt: number;
  kinds: Record<string, number>;
  /**
   * The newest plan among the folded events, and when it was written, so a
   * reader of the newest plan still finds it (docs/task-record.md).
   */
  plan?: unknown[];
  planAt?: number;
  /** The highest folded program line number per op (docs/programs.md). */
  programLines?: Partial<Record<"log" | "phase", number>>;
};

/** A graph rule refused the write; the message is meant for the agent. */
export class TaskGraphRefusal extends Error {
  override readonly name = "TaskGraphRefusal";
}

/**
 * One committed mutation, as the protocol sees it: the board sequence it
 * committed under, the rows it touched, the timeline events it inserted,
 * and whether rows vanished (a failed spawn's discard, the D-13 purge) so a
 * consumer rebuilds rather than patching.
 */
export type TaskChange = {
  seq: number;
  taskIds: string[];
  events: TaskEvent[];
  /** Ids of rows the mutation deleted; they are not in `taskIds`. */
  removed: string[];
  reset: boolean;
  /**
   * Only the presentation pass republishing rows (`refreshPresentation`):
   * it changes nothing a status reads, so it asks for no further pass.
   */
  republish?: true;
};

export type TaskChangeListener = (change: TaskChange) => void;

type PendingChange = {
  presentation: boolean;
  republish: boolean;
  taskIds: Set<string>;
  events: TaskEvent[];
  removed: Set<string>;
  reset: boolean;
};

function freshPending(): PendingChange {
  return {
    presentation: false,
    republish: false,
    taskIds: new Set(),
    events: [],
    removed: new Set(),
    reset: false,
  };
}

/** The derived state of an open row (design section 4.1, "derived on open"). */
export type TaskFlags = {
  /** An uncleared `blocks` edge points at it. */
  blocked: boolean;
  /** A gate (quota-reset, at-time, captain) holds it. */
  held: boolean;
  /** Open, unblocked, unheld work that dispatches when `startPolicy` is when-ready. */
  ready: boolean;
  /** A `blocks` edge from a dropped task: its wait can never end on its own. */
  deadBlocker: boolean;
};

/** The editable fields (update_task); every one optional. */
export type UpdateTaskPatch = {
  placementRequirements?: PlacementRequirements | null;
  correctRequiredAction?: boolean;
  policies?: TaskPolicyEdits;
  /**
   * The standing direction (its id) behind the model, Runs on and policy
   * edits of this update, so the history names it: "Merging: Merges on its
   * own, from d:...". The host stores it as the Firstmate declared it.
   */
  direction?: string;
  project?: string;
  parent?: string;
  /** Attach/recover a spec on unstarted work; empty clears it. */
  basis?: string;
  /**
   * The result shape unstarted work's report must carry (INF-799), already
   * checked by the supervisor; null clears it.
   */
  resultSchema?: Record<string, unknown> | null;
  /** The task, by key, unstarted work starts from (INF-799), already checked; empty clears it. */
  branchFrom?: string;
  /**
   * Whether open work that has not started is the first mate's own, not the
   * captain's ask (`shape.internal_step`, INF-1467): set when it starts a
   * crewmate's filing unasked.
   */
  internalStep?: boolean;
  /** A program's new bound on its task() calls (INF-799), on the captain's words. */
  programBound?: number;
  /**
   * The model the captain named for open work no crewmate holds yet - a bare
   * id or a provider-qualified key - stored as the shape's
   * `override_model_id`, so the task routes on it when it starts (R0).
   * Empty clears it.
   */
  model?: string;
  speed?: import("@shared/crewSpeed").CrewSpeed | null;
  /**
   * The reasoning effort the captain named for open work no crewmate holds
   * yet, stored as the shape's `override_reasoning`, so its crewmate opens
   * at it in place of the Settings → Models choice. Null clears it.
   */
  reasoning?: ReasoningChoice | null;
  /**
   * Where the task runs, on the captain's words before it starts
   * (docs/helper.md, "A task's own Runs on"): stored as the shape's
   * `runs_on_ask` - a device id or `this-mac` - or cleared by null, so it
   * follows its parent's or project's again. The supervisor checks the ask
   * first (`CrewSupervisor.runsOnRefusal`) and writes `words`, the
   * Details row as it now reads, into the timeline.
   */
  runsOn?: { ask: string | null; words: string };
  title?: string;
  goal?: string | null;
  priority?: number;
  startPolicy?: TaskStartPolicy;
  /** The Firstmate's one line on a filing. Empty clears it. */
  verdict?: string | null;
};

/** A task named by a refusal: enough to reference it, never the whole record. */
export type SettleTaskRef = { id: string; key: string; title: string };

/**
 * One way out of a close refusal (interaction P0, WI-12): a button on the
 * Firstmate's card, or a clause in the refusal prose. `tool` and `args` are
 * exactly what the Firstmate runs to take it - a pointing gesture, never a
 * host mutation of its own.
 */
export type SettleWay = { label: string } & (
  | {
      tool: "settle_task" | "update_task" | "link_tasks" | "app_change";
      args: Record<string, unknown>;
    }
  /**
   * A way the captain takes in Settings: the not-signed-in refusal's sign-in
   * (git integration PR 1.2), an `open` effect the Firstmate carries on its
   * card as it is.
   */
  | { effect: OpenEffect }
  /**
   * A way that is not the Firstmate's to take: a button already in front
   * of the captain, named by the card it sits on and its action id. The
   * autonomy hold has exactly one way out and this is it - the captain's
   * own click on the completion card - so the Firstmate reads a way it
   * cannot run and says nothing further rather than inventing a card
   * beside the one that is already there.
   */
  | { card: { id: string; action: string } }
);

/**
 * Why a close refused, and how to resolve it (interaction P0, WI-12, captain
 * ruling D5′). A refusal is an OUTCOME with ways out, not prose the model
 * must re-derive: the settle wake and the `settle_task` tool result carry
 * this object, and the Firstmate turns `ways` into effect buttons on one
 * card. `text` is the same refusal as one line, for the tool result's
 * content and the feed line.
 *
 * - `children-open`: a parent still has open children (the parent close
 *   rule); its ways start or drop the children, or settle keeping them
 *   planned (`proceed_with_open`), added where the settle mode is known.
 * - `waits-on`: a `blocks_me` promise still stands; its ways land the
 *   blocker or remove the edge - no override, the promise is the crewmate's.
 * - `unlanded-work`: a discard would destroy commits or edits nothing
 *   landed; its ways confirm the discard, or merge/land instead.
 * - `autonomy-off`: the Firstmate tried to merge or land a task whose
 *   effective autonomy is off, so the decision is the captain's; its one
 *   way out is the completion card's own merge button, which he clicks.
 * - `not-signed-in`: the project's host needs the app's sign-in to put the
 *   change in (git integration PR 1.2); its ways are the sign-in and
 *   keeping the project on this Mac (`src/core/forge/signInRefusal.ts`).
 */
export type SettleRefusal = {
  refused: "children-open" | "waits-on" | "unlanded-work" | "autonomy-off" | "not-signed-in";
  task: SettleTaskRef;
  /** The other tasks the refusal names (open children, live blockers). */
  tasks: SettleTaskRef[];
  ways: SettleWay[];
  text: string;
};

function settleRef(record: TaskRecord | undefined, fallbackId: string): SettleTaskRef {
  return {
    id: record?.id ?? fallbackId,
    key: record?.key || fallbackId,
    title: record?.title ?? "",
  };
}

/**
 * What a crewmate's report declared about whose turn follows it (FI3-435):
 * a wait on the captain, with its reason and the card he is to read, or its
 * work finished - at most one; the report tool refuses both. Beside either,
 * a request that the Firstmate act on this report, with its reason
 * (FI3-710): kept on that report's event, and on the record's delivery
 * facts until the next turn starts, like the others, so the idle ladder
 * can raise it again while the Firstmate leaves it unanswered (FI3-714).
 */
export type ReportDeclaration = {
  firstRelease?: FirstReleaseReport;
  workWait?: WorkWait;
  recoveryWays?: KeptRecoveryWay[];
  validation?: KeptValidationInput;
  wait?: { reason: string; cardId?: string };
  finished?: boolean;
  /** The crewmate, not a forge reading, declares whether this merge finishes its work. */
  mergeCompletesTask?: { prNumber: number; headSha: string };
  needsFirstmate?: string;
  /**
   * The report's typed result (INF-799 piece 1), already checked against
   * the task's `result_schema` when it has one: kept on the report's event,
   * the one record of it (`latestResult` reads the newest, INF-1296).
   */
  result?: Record<string, unknown>;
  /**
   * Files the report hands on (INF-992), as kept and verified: kept name,
   * size and sha256, never content. The first mate's steer delivers them.
   */
  files?: HandoverFile[];
  /**
   * When its crewmate looks again at a job still running, in minutes from
   * the report, and what it waits for (INF-1244, `check_back`): the task's
   * `at-time` gate until then, whose end steers it with the job's facts.
   */
  checkBack?: { minutes: number; waitingFor: string };
  /**
   * The tasks its crewmate says its task waits on (INF-1428, `waits_on`),
   * already resolved to live tasks: each is recorded as a `blocks` link
   * from it, a recorded wait that holds no merge (`TaskService.linkWaits`).
   */
  waitsOn?: string[];
};

/**
 * F4/F5 of INF-1554: one durable boundary for recovery facts. Scalar excerpts
 * use the existing 300-character declaration band; the list uses the shared
 * message band. Full details spill through the existing overflow owner.
 * A long fact keeps its content digest, so a changed tail is never mistaken
 * for the same observation after clipping, and identical facts stay equal.
 */
function reportRecoveryOf(declared: ReportDeclaration | undefined) {
  let overflow = false;
  const short = (text: string) => {
    if (text.length <= 300) return text;
    overflow = true;
    const digest = ` [sha256:${createHash("sha256").update(text).digest("hex")}]`;
    return text.slice(0, 300 - digest.length) + digest;
  };
  const wait = declared?.workWait;
  const workWait = wait
    ? {
        ...(wait.owner ? { owner: short(wait.owner) } : {}),
        ...(wait.end ? { end: short(wait.end) } : {}),
        observation: short(wait.observation),
        cheapestWay: short(wait.cheapestWay),
      }
    : undefined;
  const ways: KeptRecoveryWay[] = [];
  let size = 2; // The array's brackets, then each serialized item and its comma.
  for (const way of declared?.recoveryWays ?? []) {
    const bounded = {
      action: short(way.action),
      ...(way.approach ? { approach: short(way.approach) } : {}),
      hold: short(way.hold),
      evidence: short(way.evidence),
      nextFact: short(way.nextFact),
    };
    const next = JSON.stringify(recoveryWay(bounded)).length + (ways.length ? 1 : 0);
    if (size + next > MESSAGE_EXCERPT_LIMIT) {
      overflow = true;
      break;
    }
    ways.push(bounded);
    size += next;
  }
  return {
    ...(workWait ? { workWait } : {}),
    ...(ways.length ? { recoveryWays: ways } : {}),
    ...(overflow
      ? {
          overflow: capWithOverflow(
            JSON.stringify({ workWait: wait, recoveryWays: declared?.recoveryWays }),
            "report-recovery",
            { limit: 0, force: true },
          ),
        }
      : {}),
  };
}

function hasDeclaration(record: TaskRecord): boolean {
  return (
    Boolean(record.delivery?.captainWait) ||
    record.delivery?.finishedAt !== undefined ||
    record.delivery?.mergeCompletion !== undefined ||
    Boolean(record.delivery?.needsFirstmate) ||
    Boolean(record.delivery?.checkBack)
  );
}

function refName(ref: SettleTaskRef): string {
  return `${ref.key} "${ref.title}"`;
}

/**
 * One click of the captain's on a task card's own buttons (`taskCardClicksSince`),
 * or on a panel that moved the task, named by its title.
 */
export type TaskCardClick = { taskId: string; at: number; op: TaskLifecycleOp; panel?: string };

/**
 * Which button a task card history entry records, read from its typed kind:
 * the steer is Continue, the cancel request is Drop task on started work,
 * the drop before start is the footer's own drop, the start is Start, and
 * a start policy the captain set is the task board's queue or unqueue.
 */
function taskCardOp(event: TaskEvent): TaskLifecycleOp | undefined {
  const data = event.data ?? {};
  switch (event.kind) {
    case "note":
      if (typeof data.startAgain === "string") return "start-again";
      return data.startPolicy === QUEUE_POLICY["queue-task"]
        ? "queue-task"
        : data.startPolicy === QUEUE_POLICY["unqueue-task"]
          ? "unqueue-task"
          : undefined;
    case "steered":
      return "continue-task";
    case "interrupted":
      return data.effect === "aborted-turn" || data.effect === "abort-failed"
        ? undefined
        : "stop-task";
    case "status":
      return data[DROP_BEFORE_START] === true ? "drop-task" : "start-task";
    default:
      return undefined;
  }
}

/**
 * A follow-up a crewmate discovered while working (design section 7,
 * `file_followup`): a task of its own, joined to its origin by a
 * discovered-from edge alone, open on request, in the origin's project and
 * repo. It is NOT a child - discovery is provenance, not containment, and
 * the parent edge would gate the origin's close (the P2 regression: work
 * the captain asked for could not land behind follow-ups nobody chose).
 * `blocksOrigin` is the one way a follow-up holds its origin up, and it
 * says so with a blocks edge.
 */
export type FileFollowupInput = {
  id: string;
  originId: string;
  title: string;
  goal: string;
  why: string;
  /** The rendered brief the follow-up runs from when dispatched. */
  prompt: string;
  /** The discovered work must land before the origin can finish. */
  blocksOrigin?: boolean;
  actor?: TaskEventActor;
  /** The follow-up is a test failure, so `testPath` is required. */
  testFailure?: boolean;
  /** The failing test's path. The host refuses a second open row for it. */
  testPath?: string;
};

export type FileFollowupResult = {
  record: TaskRecord;
  /** An open row already named this test; nothing new was filed. */
  duplicate: boolean;
};

/** The path a filing dedupes on: slashes normalized, a leading ./ dropped. */
export function normalizeTestPath(raw: string): string | undefined {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.length > 256 || /[\n\r]/.test(path)) return undefined;
  return path;
}

const MAX_HIERARCHY_WALK = 64;

export type CreateTaskInput = {
  id: string;
  kind?: TaskKind;
  title: string;
  prompt: string;
  goal?: string | null;
  intent?: SpawnIntent | null;
  repoId: string | null;
  /** The project when it is not the repo's or Scratch (a park row follows its card). */
  projectId?: string;
  parentId?: string | null;
  difficulty?: TaskRecord["difficulty"];
  /** The work shape the tier was computed from (S2). */
  shape?: WorkShape | null;
  gate?: TaskGate | null;
  /** Tasks that must close before this one is ready (`blocks` edges). */
  blockedBy?: string[];
  priority?: number;
  startPolicy?: TaskStartPolicy;
  /** open by default; active when a crewmate takes it in the same breath. */
  status?: "open" | "active";
  activity?: TaskActivity | null;
  /**
   * The computer that runs the work, when known at creation: it rides the
   * row's first `task_changed`, so the stage places the crewmate at once
   * (docs/crew-orbits.md, "Multiple work computers"). This Mac when absent.
   */
  deviceId?: string | null;
  actor?: TaskEventActor;
  createdAt?: number;
};

export type DispatchInput = {
  workspace: {
    repoDir: string;
    worktreeDir: string;
    branch: string;
    /**
     * Its working copy is on the computer that runs work its record names,
     * with none on this Mac (docs/helper.md, "Its working copies"): present
     * all the same, until that computer retires it.
     */
    elsewhere?: boolean;
  };
  accountId: string | null;
  assignee: string;
  model?: { provider: string; id: string } | undefined;
  /** The reasoning the session opened at on that model, when it says (FI3-439). */
  reasoning?: Reasoning | undefined;
  actor?: TaskEventActor;
};

export type CloseInput = {
  status: Extract<TaskStatus, "done" | "dropped">;
  reason: TaskClosedReason;
  actor: TaskEventActor;
  /** The feed-ready line; a default is phrased from the reason. */
  text?: string;
  /** The error a failed close carries. */
  error?: string;
  /** Extra facts the close records, e.g. an escalation's `escalated_to`. */
  data?: Record<string, unknown>;
  /** Delivery facts learned by the same act (a landing's mode). */
  delivery?: Partial<TaskDelivery>;
  /**
   * Whether the close's own event reaches the feed. True by default; the
   * one caller that passes false is an escalation's supersede (S4), where
   * the `escalated` line already says the row was replaced and names its
   * successor, so a second "superseded" line would only repeat it.
   */
  feed?: boolean;
};

/**
 * The close of work another task carries on (INF-1825): done, superseded,
 * with the replaced-by link's end and its key, so Activity says "Carried on
 * by KEY" and no closing note goes up (`closedWithoutClick`).
 */
export function carriedOnClose<A extends TaskEventActor>(
  carrier: Pick<TaskRecord, "id" | "key">,
  actor: A,
): CloseInput & { status: "done"; reason: "superseded"; actor: A; text: string } {
  const key = carrier.key || carrier.id;
  return {
    status: "done",
    reason: "superseded",
    actor,
    text: `Carried on by ${key}`,
    data: { replacedBy: carrier.id, carriedBy: key },
  };
}

export type OpenAskInput = {
  /** The turn id. */
  id: string;
  text: string;
  images?: AskImage[];
  /** The message's own copies of `images` (`src/core/attachments.ts`). */
  attachments?: AttachmentRef[];
  messageFiles?: MessageFile[];
  hintTaskId?: string | null;
  at?: number;
  /** The message this one sends again (Ask again on the answer-delivery notice). */
  retryOf?: string;
};

/**
 * A standalone one-off the Firstmate answered (or the host filed at turn
 * end when nothing attached): a `question` task born closed (D1 - it exists
 * only when the ask is about no other work).
 */
export type FileQuestionInput = {
  id: string;
  title: string;
  /** The answer: the card body, or the turn's closing text for a fallback. */
  outcome: string | null;
  repoId?: string | null;
  projectId?: string;
  /** The card that carried the answer, when there was one. */
  cardId?: string;
  actor?: TaskEventActor;
  /** Why the host filed it instead of the agent (fallback provenance). */
  fallback?: "question";
};

/** A fleet/self operation the Firstmate performed: filed done/settled. */
export type FileOperationInput = {
  id: string;
  title: string;
  /** The tool's own result text. */
  outcome: string;
  tool: string;
  repoId?: string | null;
  projectId?: string;
  actor?: TaskEventActor;
};

/**
 * A decision the Firstmate raised that gates no recorded work: an open
 * `decision` task waiting on the captain (its card id is the gate ref, the
 * same shape a parked decision carries).
 */
export type FileDecisionInput = {
  id: string;
  title: string;
  cardId: string;
  repoId?: string | null;
  projectId?: string;
  actor?: TaskEventActor;
};

export type TaskServiceOptions = {
  db: AppDatabase;
  /** Delivery posture lookup for delivery facts; absent means local-only. */
  repos?: {
    get(id: string): (PolicyRepo & Partial<Pick<RepoView, "name" | "origin">>) | undefined;
  };
  now?: () => number;
  /**
   * Dev boot assertion (design section 5): the migrated record columns
   * SQLite could not make NOT NULL are checked here instead. On in a dev
   * build; a packaged app logs and continues.
   */
  strict?: boolean;
};

const CLOSE_EVENT_KIND: Record<TaskClosedReason, InsertTaskEvent["kind"]> = {
  landed: "landed",
  merged: "merged",
  released: "status",
  answered: "status",
  settled: "status",
  finished: "status",
  cancelled: "status",
  discarded: "status",
  failed: "failed",
  superseded: "status",
};

/**
 * How a link's `to` stands to its `from` - the end a `linked` event is
 * written on - and so how that event's task reads from the other end.
 */
/** How an `unlinked` line names the edge that went, read from its `to`. */
const LINK_WORDS: Record<TaskLinkType, string> = {
  blocks: "blocked by",
  "discovered-from": "discovered-from",
  "replaced-by": "replacing",
  related: "related",
};

const LINK_END_RELATION: Record<TaskLinkType, TaskConcernRelation> = {
  blocks: "waiter",
  "discovered-from": "origin",
  "replaced-by": "replacement",
  related: "related",
};

/** How a link's `from` stands to its `to`. */
const LINK_FROM_RELATION: Record<TaskLinkType, TaskConcernRelation> = {
  blocks: "blocker",
  "discovered-from": "follow-up",
  "replaced-by": "replaced",
  related: "related",
};

/**
 * A task's milestones, the events the tasks linked to it read (FI3-1189's
 * rule 1): filed, started, a pull request opened, merged, and closed - for
 * good, failed included - with why.
 */
function isMilestone(event: InsertTaskEvent): boolean {
  const status = event.data?.status;
  switch (event.kind) {
    case "created":
    case "dispatched":
    case "pr_opened":
    case "merged":
    case "landed":
      return true;
    case "status":
    case "failed":
      return status === "done" || status === "dropped";
    default:
      return false;
  }
}

function asCompacted(data: Record<string, unknown> | null): CompactedEventData | null {
  if (!data || typeof data.folded !== "number") return null;
  const kinds: Record<string, number> = {};
  if (data.kinds && typeof data.kinds === "object") {
    for (const [kind, n] of Object.entries(data.kinds as Record<string, unknown>)) {
      if (typeof n === "number") kinds[kind] = n;
    }
  }
  return {
    folded: data.folded,
    firstAt: typeof data.firstAt === "number" ? data.firstAt : Number.POSITIVE_INFINITY,
    lastAt: typeof data.lastAt === "number" ? data.lastAt : 0,
    kinds,
    ...(Array.isArray(data.plan) && typeof data.planAt === "number"
      ? { plan: data.plan, planAt: data.planAt }
      : {}),
    ...(data.programLines && typeof data.programLines === "object"
      ? { programLines: data.programLines as CompactedEventData["programLines"] }
      : {}),
  };
}

/** Keep the folded events' newest plan and highest program line numbers on the fold. */
function keepLatest(
  data: CompactedEventData,
  plan: unknown,
  planAt: number,
  lines: CompactedEventData["programLines"],
): void {
  if (Array.isArray(plan) && planAt >= (data.planAt ?? Number.NEGATIVE_INFINITY)) {
    data.plan = plan;
    data.planAt = planAt;
  }
  for (const op of ["log", "phase"] as const) {
    const n = lines?.[op];
    if (typeof n === "number" && n > (data.programLines?.[op] ?? 0))
      data.programLines = { ...data.programLines, [op]: n };
  }
}

function defaultCloseText(input: CloseInput): string {
  switch (input.reason) {
    case "landed":
      return `landed${input.delivery?.landedMode ? ` (${input.delivery.landedMode})` : ""}`;
    case "merged":
      return "merged";
    case "released":
      return "released through an external process";
    case "failed":
      return `failed: ${input.error ?? "unknown error"}`;
    default:
      return input.reason;
  }
}

/**
 * A shape as the record stores it, and the relationships it names under the
 * fields they were saved in before (INF-1296 piece 2). An empty name names
 * nothing.
 */
function splitReferences(shape: WorkShape | null): {
  shape: WorkShape | null;
  named: [TaskReferenceKind, string][];
} {
  if (!shape) return { shape, named: [] };
  const stored: WorkShape = { ...shape };
  const named: [TaskReferenceKind, string][] = [];
  for (const kind of TASK_REFERENCE_KINDS) {
    const field = REFERENCE_SHAPE_FIELDS[kind];
    const ref = stored[field];
    delete stored[field];
    if (typeof ref === "string" && ref.trim()) named.push([kind, ref]);
  }
  return { shape: stored, named };
}

function sameLink(a: TaskLink, b: TaskLink): boolean {
  return a.fromId === b.fromId && a.toId === b.toId && a.type === b.type;
}

/** A committed observation accompanying an owner-specific record write. */
export type DeliveryObservation = {
  kind: "ci" | "pr_opened" | "review" | "cap_reset" | "note";
  text: string;
  feed?: boolean;
  actor?: TaskEventActor;
  /**
   * Provenance that rides the timeline event but is no delivery fact:
   * which review a verdict came from (the replay scorer reads it).
   */
  data?: Record<string, unknown>;
};
export type ChangeEvidenceUpdate = Partial<
  Omit<
    TaskDelivery,
    | PermissionField
    | (typeof TURN_DECLARATION_FIELDS)[number]
    | (typeof HISTORY_FIELDS)[number]
    | "liveValidation"
  >
>;

export class TaskService {
  private readonly db: AppDatabase;
  private readonly store: TaskStore;
  private readonly events: TaskEventStore;
  private readonly links: TaskLinkStore;
  private readonly references: TaskReferenceStore;
  private readonly asks: AskStore;
  private readonly conversations: TaskSessionStore;
  readonly projects: ProjectStore;
  private readonly now: () => number;
  private readonly listeners = new Set<TaskChangeListener>();
  /** Nesting depth of `write()`; only the outermost commit notifies. */
  private depth = 0;
  private pending: PendingChange = freshPending();

  constructor(private readonly options: TaskServiceOptions) {
    this.db = options.db;
    this.store = new TaskStore(options.db);
    this.events = new TaskEventStore(options.db);
    this.links = new TaskLinkStore(options.db);
    this.references = this.store.references;
    this.asks = new AskStore(options.db);
    this.conversations = new TaskSessionStore(options.db);
    this.projects = new ProjectStore(options.db);
    this.now = options.now ?? (() => Date.now());
    // Boot: a turn a dead process left streaming is interrupted, not
    // resurrected; an open row keeps waiting. A dispatch claimed before
    // its worktree existed is returned to the ready query so a retry can
    // reuse the leftover branch instead of sitting interrupted forever.
    this.store.interruptLeftRunning(this.now());
    this.releaseUnstartedDispatches();
    const missing = this.store.countMissingInvariants();
    if (missing > 0) {
      const message = `${missing} task row(s) lack key/project_id/updated_at after migration.`;
      if (options.strict) throw new Error(message);
      console.warn(`[tasks] ${message}`);
    }
  }

  // ---- the change seam (P3) ----------------------------------------------

  /**
   * Hear every committed mutation, after its commit. The listener runs
   * synchronously on the writer's thread and must not write tasks itself;
   * a throw inside it is the listener's bug, so it is caught and logged
   * rather than unwinding a write that has already committed.
   */
  onChange(listener: TaskChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Publish derived host facts without rewriting activity or its idle clock. */
  refreshPresentation(taskIds: readonly string[]): void {
    this.write(() => {
      for (const id of taskIds) if (this.store.get(id)) this.touch(id);
      // Its own commit alone is a republish; inside another write it joins that one.
      if (this.depth === 1) this.pending.republish = true;
    })();
  }

  /** A derived presentation changed, without changing task state or its clocks. */
  invalidatePresentation(): void {
    this.write(() => {
      this.pending.presentation = true;
    })();
  }

  /** The board sequence of the last committed mutation (0 on a fresh database). */
  boardSeq(): number {
    const row = this.db.prepare("SELECT seq FROM task_board WHERE id = 1").get() as
      | { seq: number }
      | undefined;
    return row?.seq ?? 0;
  }

  // ---- reads --------------------------------------------------------------

  get(id: string): TaskRecord | undefined {
    return this.store.get(id);
  }

  /** The change a task carries, as its record keeps it (INF-1868 piece 1), or undefined. */
  changeFor(taskId: string): ChangeRecord | undefined {
    return this.store.changes.forTask(taskId);
  }

  byKey(key: string): TaskRecord | undefined {
    return this.store.byKey(key);
  }

  list(): TaskRecord[] {
    return this.store.list();
  }

  /** Rows waiting to start (the old queued set, every kind). */
  listOpen(): TaskRecord[] {
    return this.store.listByStatus("open");
  }

  /** Rows a crewmate holds or held and left resumable. */
  listActive(): TaskRecord[] {
    return this.store.listByStatus("active");
  }

  /** The live set: everything not closed. */
  listLive(): TaskRecord[] {
    return this.store.listByStatus("open", "active");
  }

  /** The live set and every row closed at or after `since`, oldest first. */
  listLiveOrClosedSince(since: number): TaskRecord[] {
    return this.store.listLiveOrClosedSince(since);
  }

  /** Each closed row's search fields, oldest first, without reading the rest of it. */
  listClosedSearchFields(): TaskSearchFields[] {
    return this.store.listClosedSearchFields();
  }

  /** Whether any row holds this status, answered without reading or composing one. */
  hasStatus(status: TaskStatus): boolean {
    return this.store.hasStatus(status);
  }

  /** How many rows of this kind hold this status, counted without reading them. */
  count(status: TaskStatus, kind: TaskKind): number {
    return this.store.count(status, kind);
  }

  /** These rows, oldest first; an unknown id reads as nothing. */
  getMany(ids: readonly string[]): TaskRecord[] {
    return this.store.getMany(ids);
  }

  /** How many children each of these parents has, and how many of them closed. */
  childCounts(parentIds: readonly string[]): Map<string, { total: number; closed: number }> {
    return this.store.childCounts(parentIds);
  }

  timeline(id: string): TaskEvent[] {
    return this.events.listFor(id);
  }

  /** Latest host-observed recovery fact; no session is opened by this read. */
  restartObservation(id: string): TaskEvent | undefined {
    return this.events.latestWithObject(id, "note", "restartOutcome");
  }

  /** One timeline event by its id, whatever its task; undefined once it is gone. */
  eventByIdentity(identity: string): TaskEvent | undefined {
    return this.events.byIdentity(identity);
  }

  event(eventId: number): TaskEvent | undefined {
    return this.events.get(eventId);
  }

  /** Every report on the task as its typed entry, oldest first (docs/task-record.md). */
  reportEntries(id: string): ReportEntry[] {
    return this.events
      .listFor(id)
      .filter((event) => event.kind === "report")
      .map(reportEntryOf);
  }

  /**
   * The task's latest typed result (INF-799): the newest report entry that
   * carried one, or the copy an older release kept on its delivery facts
   * while no later report carried another (`latestResultOf`).
   */
  latestResult(id: string): TaskResult | undefined {
    const record = this.store.get(id);
    if (!record) return undefined;
    const newest = this.events.latestWithObject(id, "report", "result");
    return latestResultOf(newest ? reportEntryOf(newest) : undefined, record.delivery?.result);
  }

  /** When the task's crewmate last reported (INF-1244: its crew line says how long ago). */
  lastReportAt(id: string): number | undefined {
    return this.events.latestAt(id, "report");
  }

  /**
   * The events other tasks wrote that concern this one, in timeline order,
   * each with how its task stands to this one (docs/task-record.md, "Whom
   * an event concerns"). The task's Activity reads them as rows of their own.
   */
  concerning(id: string): ConcernedTaskEvent[] {
    return this.events.listConcerning(id);
  }

  /** Whom each event concerns, by event id: what the task export carries with each event. */
  eventConcerns(): Map<number, TaskConcern[]> {
    const byEvent = new Map<number, TaskConcern[]>();
    for (const { eventId, ...concern } of this.events.listAllConcerns()) {
      const list = byEvent.get(eventId) ?? [];
      list.push(concern);
      byEvent.set(eventId, list);
    }
    return byEvent;
  }

  /**
   * The captain's clicks on task cards' own buttons at or after `since`,
   * newest first (FI3-695), read off the history entries each click wrote
   * with `via: "task-card"`. One click is one entry: a cancel's outcome
   * after its request (`aborted-turn`, `abort-failed`) is not a second one.
   */
  taskCardClicksSince(since: number): TaskCardClick[] {
    return this.events
      .listByActorViaSince("captain", TASK_CARD_VIA, since)
      .flatMap((event): TaskCardClick[] => {
        const op = taskCardOp(event);
        const panel = typeof event.data?.panel === "string" ? event.data.panel : undefined;
        return op ? [{ taskId: event.taskId, at: event.at, op, ...(panel ? { panel } : {}) }] : [];
      });
  }

  /**
   * Pin the brief a first turn serves independently of later report
   * replacement; the standing directions every turn adds are not part of
   * it. The report text it copied off the record is kept as a
   * reference to its event where that is smaller (`./briefReceipt.ts`);
   * `servedBrief` reads it back whole.
   */
  recordBrief(id: string, brief: readonly BriefPart[]): void {
    const { text, refs } = compactBrief(brief);
    const run = this.write(() => {
      this.mustGet(id);
      this.addEvent({
        taskId: id,
        at: this.now(),
        actor: "host",
        kind: "briefed",
        text,
        ...(refs.length > 0 ? { data: { reports: refs } } : {}),
        feed: false,
      });
    });
    run();
  }

  /** The brief a `briefed` receipt served, each referenced report read back off the record. */
  servedBrief(receipt: TaskEvent): string {
    const reports = new Map<string, TaskEvent[]>();
    return expandBrief(receipt.text, receipt.data, (ref) => {
      let own = reports.get(ref.task);
      if (!own) {
        own = this.events.listFor(ref.task).filter((event) => event.kind === "report");
        reports.set(ref.task, own);
      }
      const named = own.find((event) => event.id === ref.event);
      if (named && reportHash(named.text) === ref.sha256) return named.text;
      return own.find((event) => reportHash(event.text) === ref.sha256)?.text;
    });
  }

  /** Whether the pinned served brief actually contained a particular contract. */
  briefContains(id: string, text: string): boolean {
    return this.timeline(id).some(
      (event) =>
        event.kind === "briefed" &&
        this.servedBrief(event).replace(/\s+/g, " ").includes(text.replace(/\s+/g, " ")),
    );
  }

  /** The tasks that must close before this one is ready. */
  blockers(id: string): TaskRecord[] {
    return this.links
      .listTo(id, "blocks")
      .flatMap((link) => [this.store.get(link.fromId)].filter((r): r is TaskRecord => !!r));
  }

  /** The tasks waiting on this one. */
  blocking(id: string): TaskRecord[] {
    return this.links
      .listFrom(id, "blocks")
      .flatMap((link) => [this.store.get(link.toId)].filter((r): r is TaskRecord => !!r));
  }

  linksTo(id: string): TaskLink[] {
    return this.links.listTo(id);
  }

  linksFrom(id: string): TaskLink[] {
    return this.links.listFrom(id);
  }

  /** Every edge in the graph, for a builder that resolves them in one pass. */
  allLinks(): TaskLink[] {
    return this.links.listAll();
  }

  /** Every edge from or to one of these tasks, in `allLinks` order. */
  linksTouching(ids: readonly string[]): TaskLink[] {
    return this.links.listTouching(ids);
  }

  /** The newest feed-worthy timeline events across every task, newest first. */
  /**
   * The contribution channel's backlog (roadmap 1.4): the R2 `decided`
   * records newer than the last send, newest first and capped, and the
   * whole backlog's size. Reads only; the sharing service redacts them.
   */
  decisionBacklog(since: number, limit: number): TaskEvent[] {
    return this.events.listByKindSince("decided", since, limit);
  }

  decisionBacklogCount(since: number): number {
    return this.events.countByKindSince("decided", since);
  }

  listFeedEvents(limit: number): TaskEvent[] {
    return this.events.listFeed(limit);
  }

  getAsk(id: string): AskRecord | undefined {
    return this.asks.get(id);
  }

  /** Asks whose turn has not closed - the host's turn scope. */
  listOpenAsks(): AskRecord[] {
    return this.asks.listOpen();
  }

  /** The messages the answer-delivery check holds in one state. */
  listAsksByDelivery(delivery: AskDelivery): AskRecord[] {
    return this.asks.listByDelivery(delivery);
  }

  /** The asks that first attached to this task. */
  asksFor(id: string): AskRecord[] {
    return this.asks.listFor(id);
  }

  /**
   * The captain's message a task's cards are about (INF-1610, the "You
   * asked" line): read from the saved messages through the task graph,
   * never from any card's words. Work handed over to this task - the task
   * it replaced, retried at a stronger model, or branched from - keeps the
   * first message, so its own message about the move never takes its
   * place. Otherwise it is the oldest message attached to the task, and a
   * task with none - a part, or work built on a plan - reads its parent's,
   * then its basis's.
   */
  askAbout(id: string, seen: Set<string> = new Set()): AskRecord | undefined {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const record = this.store.get(id);
    if (!record) return undefined;
    const references = this.references.list(id);
    const handedOver = [
      ...this.links.listTo(id, "replaced-by").map((link) => link.fromId),
      ...references
        .filter((entry) => entry.kind === "retry-of" || entry.kind === "branch-source")
        .flatMap((entry) => this.referenceTarget(entry)?.id ?? []),
    ];
    for (const from of handedOver) {
      const ask = this.askAbout(from, seen);
      if (ask) return ask;
    }
    const own = this.events.oldestRef(id, "ask");
    const ask = own ? this.asks.get(own) : undefined;
    if (ask) return ask;
    const basis = references.find((entry) => entry.kind === "basis");
    const above = [record.parentId, basis && this.referenceTarget(basis)?.id];
    for (const next of above) {
      if (!next) continue;
      const found = this.askAbout(next, seen);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * The work a captain's messages cover (docs/task-capture.md "How a
   * message ends"): the tasks they attached to, those tasks' parts, the
   * work built on them, and the work handed over from them - a
   * replacement, a stronger model, a retry or a branch taken from one.
   * With `before`, work filed after that time is left out, apart from a
   * task a message attached to itself: work linked after a message was
   * answered belongs to the newer message.
   */
  askWork(askIds: readonly string[], before?: number): TaskRecord[] {
    const found = new Map<string, TaskRecord>();
    const queue = askIds.flatMap((askId) => this.events.taskIdsWithRef("ask", askId));
    const seeds = new Set(queue);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (found.has(id)) continue;
      const record = this.store.get(id);
      if (!record) continue;
      if (before !== undefined && !seeds.has(id) && record.createdAt > before) continue;
      found.set(id, record);
      queue.push(...this.workAfter(record));
    }
    return [...found.values()];
  }

  /**
   * The tasks the first mate's own tools attached these messages to: work
   * it filed, started, steered or settled for them - never the host's
   * fallback to the task a message pointed at.
   */
  askActedOn(askIds: readonly string[]): Set<string> {
    const ids = new Set(askIds);
    const acted = new Set<string>();
    for (const askId of askIds) {
      for (const taskId of this.events.taskIdsWithRef("ask", askId)) {
        const tool = this.events
          .listFor(taskId)
          .some(
            (event) =>
              event.kind === "ask" &&
              event.ref !== null &&
              ids.has(event.ref) &&
              typeof event.data?.via === "string" &&
              event.data.via.startsWith("tool:"),
          );
        if (tool) acted.add(taskId);
      }
    }
    return acted;
  }

  /** The tasks that carry a task's work on: its parts, what builds on it and its handovers. */
  private workAfter(record: TaskRecord): string[] {
    const key = record.key || null;
    return [
      ...this.store.listChildren(record.id).map((child) => child.id),
      ...this.links.listFrom(record.id, "replaced-by").map((link) => link.toId),
      ...(["basis", "retry-of", "branch-source"] as const).flatMap((kind) =>
        this.references.taskIdsNaming(kind, record.id, key),
      ),
      ...this.escalations(record.id, "escalated_to"),
    ];
  }

  /** The tasks a task's work came from: the inverse of `workAfter`. */
  private workBefore(record: TaskRecord): string[] {
    return [
      ...(record.parentId ? [record.parentId] : []),
      ...this.links.listTo(record.id, "replaced-by").map((link) => link.fromId),
      ...this.references
        .list(record.id)
        .filter(
          (entry) =>
            entry.kind === "basis" || entry.kind === "retry-of" || entry.kind === "branch-source",
        )
        .flatMap((entry) => this.referenceTarget(entry)?.id ?? []),
      ...this.escalations(record.id, "escalated_from"),
    ];
  }

  /** The other attempt a stronger-model move names, on the side `side` records. */
  private escalations(id: string, side: "escalated_to" | "escalated_from"): string[] {
    return this.events
      .listFor(id)
      .filter((event) => event.kind === "escalated" && typeof event.data?.[side] === "string")
      .flatMap((event) => (event.ref ? [event.ref] : []));
  }

  /**
   * The captain's messages whose work includes this task, newest first:
   * those attached to it or to the work it came from. A message answered
   * before the task was filed is left out unless it attached to the task
   * itself (`askWork`'s rule, from the other side).
   */
  asksAbove(id: string): AskRecord[] {
    const seen = new Set<string>();
    const asks = new Map<string, AskRecord>();
    const target = this.store.get(id);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const record = this.store.get(current);
      if (!record) continue;
      for (const ref of this.events.refsOf(current, "ask")) {
        const ask = this.asks.get(ref);
        if (!ask || asks.has(ask.id)) continue;
        const later =
          current !== id &&
          target !== undefined &&
          ask.answeredAt !== null &&
          target.createdAt > ask.answeredAt;
        if (!later) asks.set(ask.id, ask);
      }
      queue.push(...this.workBefore(record));
    }
    return [...asks.values()].sort((a, b) => b.at - a.at);
  }

  /** Followed messages that have not ended, oldest first. */
  listAsksNotEnded(): AskRecord[] {
    return this.asks.listNotEnded();
  }

  /** A message and every message that joined its work, oldest first. */
  askMembers(rootId: string): AskRecord[] {
    const root = this.asks.get(rootId);
    return root ? [root, ...this.asks.listContinuing(rootId)] : [];
  }

  /** The captain accepted a card as the answer to these messages. */
  acceptAnswer(askIds: readonly string[], cardId: string): void {
    const at = this.now();
    this.write(() => {
      for (const id of askIds) this.asks.setAccepted(id, cardId, at);
    })();
  }

  /** These messages are answered, on a card or by a reaction: final. */
  markAnswered(askIds: readonly string[], cardId: string | null): void {
    const at = this.now();
    this.write(() => {
      for (const id of askIds) this.asks.setAnswered(id, cardId, at);
    })();
  }

  /** The once a message's last crewmate was asked for its answering card. */
  markCrewmateAsked(askId: string): void {
    const at = this.now();
    this.write(() => this.asks.setCrewmateAsked(askId, at))();
  }

  /** Complete text files the messages attached to this task kept at acceptance. */
  messageFiles(id: string): MessageFile[] {
    return this.events
      .listFor(id)
      .filter((event) => event.kind === "ask" && event.ref)
      .flatMap((event) => this.asks.get(event.ref as string)?.messageFiles ?? []);
  }

  /** The captain's pictures, in message order, each copy once. */
  pictures(id: string): AttachmentRef[] {
    const seen = new Set<string>();
    return this.events
      .listFor(id)
      .filter((event) => event.kind === "ask" && event.ref)
      .flatMap((event) => this.asks.get(event.ref as string)?.attachments ?? [])
      .filter((ref) => {
        if (seen.has(ref.id)) return false;
        seen.add(ref.id);
        return true;
      });
  }

  listAsks(): AskRecord[] {
    return this.asks.list();
  }

  /** The captain's newest message's id: the one a turn's reply line answers. */
  latestAskId(): string | undefined {
    return this.asks.latestId();
  }

  /** The last turn above the input: the newest message and its reply line. */
  lastTurn(): LastTurn | null {
    return this.asks.lastTurn();
  }

  /** The Firstmate's reply line beside a message, kept for the next launch. */
  setAskReply(askId: string, reply: LastTurnReply): void {
    this.write(() => this.asks.setReply(askId, reply))();
  }

  /**
   * The task as it stands right now, as a copy a card choice keeps beside
   * it (docs/card-evidence.md): its identity and state, its gate, what its
   * delivery last read, what it waits on, and the asks it carries. Read
   * before the choice moves the task, so it is the input the choice was
   * made on, never the row it became. Reads only.
   */
  decisionContext(id: string): CardDecisionContext | undefined {
    const record = this.store.get(id);
    if (!record) return undefined;
    const delivery = record.delivery;
    return {
      at: this.now(),
      taskId: record.id,
      key: record.key,
      kind: record.kind,
      status: record.status,
      activity: record.activity,
      parentId: record.parentId,
      gate: record.gate
        ? { kind: record.gate.kind, ...(record.gate.ref ? { ref: record.gate.ref } : {}) }
        : null,
      delivery: delivery
        ? {
            mode: delivery.mode,
            ...(delivery.changeLabel ? { changeLabel: delivery.changeLabel } : {}),
            ...(delivery.headSha ? { headSha: delivery.headSha } : {}),
            ...(delivery.ci ? { checks: delivery.ci } : {}),
            ...(delivery.ciAt !== undefined ? { checksAt: delivery.ciAt } : {}),
            ...(delivery.reviewVerdict ? { review: delivery.reviewVerdict } : {}),
            ...(delivery.reviewSha ? { reviewSha: delivery.reviewSha } : {}),
            ...(delivery.reviewedAt !== undefined ? { reviewedAt: delivery.reviewedAt } : {}),
            settlePending: Boolean(record.pendingSettle),
          }
        : null,
      blockers: this.blockers(id).map((blocker) => ({ id: blocker.id, status: blocker.status })),
      asks: this.asksFor(id).map((ask) => ask.id),
    };
  }

  /**
   * The open decision row a card carries: a decision the Firstmate raised
   * without a task (P1), which keeps the card id as its captain gate's ref
   * and lives exactly as long as the card is on the stack.
   */
  openDecisionFor(cardId: string): TaskRecord | undefined {
    return this.store
      .listByStatus("open")
      .find((record) => record.kind === "decision" && record.gate?.ref === cardId);
  }

  /**
   * The open row that exists only for a card: a Firstmate decision filed
   * without a task, or the operation row a host card with no task files
   * (`fileHostCardTask`). Either keeps the card id as its captain gate's
   * ref and closes when the card leaves the stack.
   */
  openCardTaskFor(cardId: string): TaskRecord | undefined {
    return this.store
      .listByStatus("open")
      .find(
        (record) =>
          (record.kind === "decision" ||
            (record.kind === "operation" && !record.delivery?.captainAction)) &&
          record.gate?.kind === "captain" &&
          record.gate.ref === cardId,
      );
  }

  /** A blocker clears its wait only when done; a dropped one can never clear. */
  static blockerCleared(blocker: TaskRecord): boolean {
    return blocker.status === "done";
  }

  /** Closed = no longer open or active: done or dropped. */
  static isClosed(record: TaskRecord): boolean {
    return record.status !== "open" && record.status !== "active";
  }

  /**
   * An active row a previous process left idle or interrupted: steerable by
   * resume. A row whose crewmate runs on a computer that runs work is
   * resumable whatever it was doing: a turn it was running went on there,
   * and resuming follows it (docs/helper.md, "Holding a conversation").
   */
  static isResumable(record: TaskRecord): boolean {
    return (
      record.status === "active" &&
      (record.activity === "idle" || record.activity === "interrupted" || Boolean(record.deviceId))
    );
  }

  /**
   * A child the HOST commissioned as part of delivering its parent - a
   * `host:*` kind_source: the independent review (captain ruling
   * 2026-09-19) and the independent assessment of a kept merge's undecided
   * repair (FI3-663). Delivery machinery carries no intent of its own:
   * it never holds the parent's close (`closeRefusal` skips it), its
   * parent is fixed (`setParent` refuses), and the supervisor retires it
   * whenever the parent closes.
   */
  static isDeliveryChild(record: TaskRecord): boolean {
    return isHostRaisedShape(record.shape);
  }

  // ---- graph reads (P2) ---------------------------------------------------

  /** A task by id or by key (`FM3K-12`, any case); tools accept either. */
  resolve(ref: string): TaskRecord | undefined {
    const trimmed = ref.trim();
    if (!trimmed) return undefined;
    return this.store.get(trimmed) ?? this.store.byKey(trimmed);
  }

  /**
   * Whether a named basis really carries a spec, a plan or a reproduction:
   * it resolves to a task that is done or has reported something. Derived
   * at every read and never stored, so a step planned behind a basis that
   * has not answered yet reads verified the moment the answer lands.
   */
  basisHolds(ref: string): boolean {
    const basis = this.resolve(ref);
    return basis !== undefined && (basis.status === "done" || Boolean(basis.outcome));
  }

  /** A task's basis as the record names it, with its verdict derived now. */
  basisOf(record: TaskRecord): { ref: string; verified: boolean } | null {
    const basis = this.reference(record.id, "basis");
    if (!basis) return null;
    return { ref: basis.ref, verified: this.basisHolds(basis.ref) };
  }

  /** A task's reference of one kind, as recorded (INF-1296 piece 2). */
  reference(id: string, kind: TaskReferenceKind): TaskReference | undefined {
    return this.references.list(id).find((reference) => reference.kind === kind);
  }

  /**
   * The task a reference names now: what its name resolves to at this read,
   * as every reader of the shape resolves it. `targetId` keeps what the name
   * meant when it was recorded, as provenance; it decides nothing.
   */
  referenceTarget(reference: TaskReference): TaskRecord | undefined {
    return this.resolve(reference.ref);
  }

  /**
   * Every relationship from or to this task, through one contract
   * (`taskRelationships.ts`): its parent edge and its children's, its links,
   * its own references and the references that name it.
   */
  relationshipsOf(id: string): TaskRelationship[] {
    const record = this.store.get(id);
    if (!record) return [];
    const parent: TaskRelationship[] = [
      ...(record.parentId ? [record] : []),
      ...this.store.listChildren(id),
    ].map((child) => ({
      kind: "parent",
      from: child.id,
      to: child.parentId,
      actor: null,
      at: null,
    }));
    const links = [...this.links.listTo(id), ...this.links.listFrom(id)]
      .filter((link, index, all) => all.findIndex((other) => sameLink(other, link)) === index)
      .map(
        (link): TaskRelationship => ({
          kind: link.type,
          from: link.fromId,
          to: link.toId,
          actor: link.actor,
          at: link.createdAt,
          ...(link.holdsMerge ? { holdsMerge: true as const } : {}),
        }),
      );
    const reference = (taskId: string, entry: TaskReference): TaskRelationship => ({
      kind: entry.kind,
      from: taskId,
      to: this.referenceTarget(entry)?.id ?? null,
      ref: entry.ref,
      actor: entry.actor,
      at: entry.recordedAt,
    });
    const own = this.references.list(id).map((entry) => reference(id, entry));
    const naming = TASK_REFERENCE_KINDS.flatMap((kind) =>
      this.references.taskIdsNaming(kind, id, record.key || null).flatMap((taskId) =>
        this.references
          .list(taskId)
          .filter((entry) => entry.kind === kind)
          .map((entry) => reference(taskId, entry)),
      ),
    );
    return [...parent, ...links, ...own, ...naming];
  }

  /**
   * Every task built on this one - each whose basis names it, by key or id
   * - open, active, done or dropped, oldest first (INF-976). Several may
   * stand on one basis; which of them covers a request is the reader's
   * judgment, never the host's. The host's delivery machinery (a review,
   * whose basis is its builder) is a part of the task, never work on it.
   */
  builtOn(id: string): TaskRecord[] {
    const record = this.store.get(id);
    if (!record) return [];
    return this.store
      .getMany(this.references.taskIdsNaming("basis", record.id, record.key || null))
      .filter((other) => !TaskService.isDeliveryChild(other));
  }

  /**
   * The review whose verdict a builder's delivery facts carry, read off the
   * parent edge: the newest review child opened at or before the verdict
   * was recorded. A review opened after it has not answered yet, so it
   * never claims the verdict of the one before it.
   */
  verdictReviewOf(builder: TaskRecord): TaskRecord | undefined {
    const reviewedAt = builder.delivery?.reviewedAt;
    if (reviewedAt === undefined) return undefined;
    return this.store
      .listChildren(builder.id)
      .filter(
        (child) =>
          child.shape?.kind === "review" &&
          !isRepairAssessment(child.shape) &&
          child.createdAt <= reviewedAt,
      )
      .at(-1);
  }

  children(id: string): TaskRecord[] {
    return this.store.listChildren(id);
  }

  /** Children not yet closed - the ones the parent close rule names. */
  openChildren(id: string): TaskRecord[] {
    return this.store.listChildren(id).filter((child) => !TaskService.isClosed(child));
  }

  /** Every descendant, shallowest first. */
  descendants(id: string): TaskRecord[] {
    return this.store.listDescendants(id);
  }

  /** The parent chain, nearest first; stops at a broken or too-deep chain. */
  ancestors(id: string): TaskRecord[] {
    const chain: TaskRecord[] = [];
    let current = this.store.get(id);
    const seen = new Set<string>([id]);
    while (current?.parentId && chain.length < MAX_HIERARCHY_WALK) {
      if (seen.has(current.parentId)) break;
      seen.add(current.parentId);
      const parent = this.store.get(current.parentId);
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  /** The follow-ups filed from this task (discovered-from edges pointing at it). */
  discoveredFrom(id: string): TaskRecord[] {
    return this.links
      .listTo(id, "discovered-from")
      .flatMap((link) => [this.store.get(link.fromId)].filter((r): r is TaskRecord => !!r));
  }

  /**
   * The tasks this one was discovered from - its origins. A follow-up is no
   * longer a child of its origin, so this edge is the only thing that says
   * where it came from; the index and the `tasks` query show it, or a
   * detached follow-up would be a row with no story.
   */
  discoveredOrigins(id: string): TaskRecord[] {
    return this.links
      .listFrom(id, "discovered-from")
      .flatMap((link) => [this.store.get(link.toId)].filter((r): r is TaskRecord => !!r));
  }

  /** The task that replaced this one, including the older stronger-model lineage. */
  replacementOf(id: string): string | undefined {
    const link = this.links.listFrom(id, "replaced-by")[0];
    if (link) return this.store.get(link.toId)?.key || link.toId;
    const retry = this.timeline(id).findLast(
      (event) => typeof event.data?.escalated_to === "string",
    );
    return retry?.data?.escalated_to as string | undefined;
  }

  /**
   * The task that carries this one's work now (INF-1826): the end of its
   * `replaced-by` links, or the task itself when nothing replaced it.
   */
  carrierOf(id: string): TaskRecord | undefined {
    let record = this.store.get(id);
    const seen = new Set<string>();
    while (record && !seen.has(record.id)) {
      seen.add(record.id);
      const next = this.links.listFrom(record.id, "replaced-by")[0];
      const carrier = next ? this.store.get(next.toId) : undefined;
      if (!carrier) return record;
      record = carrier;
    }
    return record;
  }

  /**
   * Why `carrierId` cannot carry on `id`'s work (INF-1825), or undefined:
   * not the task itself, not a task under it (its close would take it
   * along), and not a dropped task, which does no work.
   */
  carrierRefusal(id: string, carrierId: string): string | undefined {
    const record = this.mustGet(id);
    const carrier = this.mustGet(carrierId);
    const key = record.key || record.id;
    const other = carrier.key || carrier.id;
    if (carrier.id === record.id) return `Refused: ${key} cannot be replaced by itself.`;
    if (this.ancestors(carrier.id).some((ancestor) => ancestor.id === record.id))
      return `Refused: ${other} is under ${key}, so closing ${key} would close it too; name a task outside it.`;
    if (carrier.status === "dropped")
      return `Refused: ${other} is dropped itself, so it does not do ${key}'s work.`;
    const named = this.links.listFrom(record.id, "replaced-by")[0];
    const elsewhere = named && named.toId !== carrier.id ? this.store.get(named.toId) : undefined;
    if (elsewhere)
      return `Refused: ${elsewhere.key || elsewhere.id} already carries on ${key}'s work.`;
    return undefined;
  }

  /**
   * Where the work of a task closed as carried on stands (INF-1825): the
   * task at the end of its replacement chain, and whether that task still
   * runs, is done or was dropped. Undefined for any other close.
   */
  carriedOn(id: string): { key: string; state: "running" | "done" | "dropped" } | undefined {
    const record = this.store.get(id);
    if (record?.status !== "done" || record.closedReason !== "superseded") return undefined;
    const carrier = this.carrierOf(id);
    if (!carrier || carrier.id === id) return undefined;
    const state = TaskService.isClosed(carrier) ? carrier.status : "running";
    return { key: carrier.key || carrier.id, state: state as "running" | "done" | "dropped" };
  }

  /** Predecessors are work to recover, never a spec or a routing discount. */
  replacedPredecessors(id: string): TaskRecord[] {
    return this.links
      .listTo(id, "replaced-by")
      .flatMap((link) => [this.store.get(link.fromId)].filter((row): row is TaskRecord => !!row));
  }

  startAgainRefusal(id: string): string | undefined {
    const record = this.get(id);
    if (!record) return "This task could not be found.";
    const key = record.key || id;
    if (record.kind !== "work" || record.status !== "dropped")
      return `${key} is not dropped work. Only dropped work starts again.`;
    const replacement = this.replacementOf(id);
    if (replacement) return `${replacement} already replaces ${key}. Open that task instead.`;
    if (this.children(id).length) return `${key} has parts. Start a part again instead.`;
    return undefined;
  }

  /** Copy the specification and move outstanding waits in one transaction. */
  startAgain(
    id: string,
    input: {
      id: string;
      shape: WorkShape;
      actor: "captain" | "firstmate";
      via?: typeof TASK_CARD_VIA;
      panel?: string;
    },
  ): TaskRecord {
    return this.write(() => {
      const refusal = this.startAgainRefusal(id);
      if (refusal) throw new TaskGraphRefusal(refusal);
      const old = this.mustGet(id);
      const parent = old.parentId ? this.get(old.parentId) : undefined;
      const fresh = this.create({
        id: input.id,
        kind: "work",
        title: old.title,
        goal: old.goal,
        intent: old.intent,
        prompt: old.prompt,
        repoId: old.repoId,
        projectId: old.projectId,
        priority: old.priority,
        ...(parent && !TaskService.isClosed(parent) ? { parentId: parent.id } : {}),
        shape: input.shape,
        startPolicy: "on-request",
        actor: input.actor,
      });
      // The link moves the outstanding waits with it (`moveWaits`).
      this.link(id, fresh.id, "replaced-by", input.actor);
      this.note(id, `Started again as ${fresh.key}.`, {
        actor: input.actor,
        news: true,
        data: {
          startAgain: fresh.key,
          ...(input.via ? { via: input.via } : {}),
          ...(input.panel ? { panel: input.panel } : {}),
        },
      });
      return fresh;
    })();
  }

  /**
   * The ready query (design section 7): open, unheld, when-ready work whose
   * every blocker closed successfully. The R1 sweep dispatches these.
   */
  listReady(): TaskRecord[] {
    return this.store.listReady();
  }

  /** Open, unheld work waiting on a dropped task - a wait that cannot end. */
  listDeadBlocked(): TaskRecord[] {
    return this.store.listDeadBlocked();
  }

  /** The uncleared blockers of a task. */
  waitingOn(id: string): TaskRecord[] {
    return this.blockers(id).filter((blocker) => !TaskService.blockerCleared(blocker));
  }

  /**
   * Derived flags for a live row; everything false once it is closed.
   * `blocked` and `deadBlocker` hold for ACTIVE work too, and only for a
   * marked edge: a follow-up filed with `blocks_me` lands on a task a
   * crewmate is holding, and that is the one row that must show it. A
   * recorded wait holds the start and draws the arrow, and the origin
   * stays free to merge.
   * `ready` stays a property of open, unstarted work.
   */
  flagsOf(record: TaskRecord): TaskFlags {
    if (record.status === "open") {
      const waiting = this.waitingOn(record.id);
      const blocked = waiting.length > 0;
      const held = record.gate !== null;
      return {
        blocked,
        held,
        ready: record.kind === "work" && !blocked && !held,
        deadBlocker: waiting.some((blocker) => blocker.status === "dropped"),
      };
    }
    if (record.status === "active") {
      // Readiness is behind an active row, but a blocks edge filed mid-task
      // still holds its close - so the row being held must say so rather
      // than look free until the merge refuses. A dropped blocker does not
      // hold a close (`blockerHoldsClose`), so it is no dead wait here. A
      // gate holds an active row the way it holds an open one: a card up
      // for the captain, a round cap, or a timed wait (docs/task-graph.md).
      return {
        blocked: this.blockersHoldingClose(record.id).length > 0,
        held: record.gate !== null,
        ready: false,
        deadBlocker: false,
      };
    }
    return { blocked: false, held: false, ready: false, deadBlocker: false };
  }

  /**
   * Whether only a start - the Firstmate's or the captain's - begins this
   * work (FI3-671): it is open and the ready sweep will not start it (on
   * request, held, or waiting on blockers of its own), or it was dropped.
   */
  awaitsStart(record: TaskRecord): boolean {
    if (record.status === "dropped") return true;
    if (record.status !== "open") return false;
    return !(record.startPolicy === "when-ready" && this.flagsOf(record).ready);
  }

  /**
   * The parent close rule (design section 7): a parent closes only when
   * every child is closed. Returns the structured refusal (WI-12) naming the
   * open children and the ways out, or undefined when the row may close. The
   * settle path adds the mode-specific `proceed_with_open` way; the ways here
   * are the ones that hold whoever closes - drop or start each child.
   */
  closeRefusal(id: string): SettleRefusal | undefined {
    // Delivery machinery (a host-commissioned child, e.g. the review) never
    // holds its parent's close: the blocks rule is the review's one hold,
    // and the supervisor retires such children with the parent's close.
    const open = this.openChildren(id).filter((child) => !TaskService.isDeliveryChild(child));
    if (open.length === 0) return undefined;
    const task = settleRef(this.store.get(id), id);
    const children = open.map((child) => settleRef(child, child.id));
    const names = children.map(refName).join(", ");
    const them = open.length === 1 ? "it" : "them";
    const they = open.length === 1 ? "it can" : "they can";
    const ways: SettleWay[] = [];
    for (const child of children) {
      ways.push({
        label: `Start ${child.key} first`,
        tool: "update_task",
        args: {
          task: child.key,
          start_policy: "when-ready",
          blocked_by: this.waitingOn(child.id).map((blocker) => blocker.key || blocker.id),
        },
      });
      ways.push({
        label: `Drop ${child.key}`,
        tool: "update_task",
        args: { task: child.key, drop: true, reason: "superseded", confirm: true },
      });
    }
    const text = `Cannot close ${task.key} while ${open.length === 1 ? "its child is" : `${open.length} children are`} still open: ${names}. Start ${them} so ${they} close, drop ${them} as superseded, or settle ${task.key} keeping ${them} planned.`;
    return { refused: "children-open", task, tasks: children, ways, text };
  }

  /**
   * A blocker still holds a close while it is live work - open or active.
   * A done blocker cleared it honestly; a DROPPED blocker clears it
   * too, and only here. For readiness a dropped blocker is a wait that can
   * never end, and the captain answers that on the dead-gate card; for
   * CLOSING, work that is not happening must never hold a merge hostage -
   * an active origin is not even eligible for that card (`listDeadBlocked`
   * reads open rows), so it would strand with no way out.
   */
  static blockerHoldsClose(blocker: TaskRecord): boolean {
    return blocker.status === "open" || blocker.status === "active";
  }

  /**
   * The blockers that still hold this task's close; empty when none do.
   * Only a marked edge holds the close (INF-416 piece E): a `blocks_me`
   * filing, the host's review edge, or a required action's prerequisite.
   * A recorded wait keeps the edge, and the start, and holds nothing here.
   */
  blockersHoldingClose(id: string): TaskRecord[] {
    const marked = new Set(
      this.links
        .listTo(id, "blocks")
        .filter((link) => link.holdsMerge)
        .map((link) => link.fromId),
    );
    return this.blockers(id).filter(
      (blocker) => marked.has(blocker.id) && TaskService.blockerHoldsClose(blocker),
    );
  }

  /**
   * What the task's Blocked by names in the tasks reader, by the board's own
   * rule (./holdingWaits.ts, INF-999): the waits that hold it now.
   * `idleOnWaits` says its crewmate stands idle on its waits.
   */
  waitsHolding(id: string, idleOnWaits: boolean): TaskRecord[] {
    const record = this.store.get(id);
    if (!record) return [];
    const marked = new Set(
      this.links
        .listTo(id, "blocks")
        .filter((link) => link.holdsMerge)
        .map((link) => link.fromId),
    );
    return holdingWaits({
      record,
      blockers: this.blockers(id),
      holdsMerge: (blocker) => marked.has(blocker.id),
      tasks: this.store,
      idleOnWaits,
    });
  }

  /**
   * The blocks rule at close time: a task that something must land before
   * does not close until it has. This is what `file_followup`'s `blocks_me`
   * promises ("your task cannot land until this does"); blocks edges
   * otherwise gate dispatch alone, which says nothing about work already
   * under way. Returns the refusal naming the blockers and the ways out.
   */
  blockerRefusal(id: string): SettleRefusal | undefined {
    // The captain's override passes a must-merge-first wait (`waits`), and
    // the host's review edge with the review itself (`review`).
    const record = this.store.get(id);
    const delivery = record?.delivery;
    const holding = this.blockersHoldingClose(id).filter(
      (blocker) =>
        !record || !overridePasses(delivery, holdKindOf(record, blocker), delivery?.headSha),
    );
    if (holding.length === 0) return undefined;
    const task = settleRef(this.store.get(id), id);
    const blockers = holding.map((blocker) => settleRef(blocker, blocker.id));
    const names = blockers.map(refName).join(", ");
    const them = holding.length === 1 ? "it" : "them";
    // No `proceed_with_open`: a blocks_me edge is the crewmate's own promise
    // that its task cannot land until this does. The ways out land the
    // blocker, drop it, retract the promise, or the captain's override.
    const ways: SettleWay[] = [];
    for (const blocker of blockers) {
      ways.push({
        label: `Remove the wait on ${blocker.key}`,
        tool: "link_tasks",
        args: { from: blocker.key, to: task.key, type: "blocks", remove: true },
      });
    }
    // The task's own review holds in review vocabulary: the honest doors
    // are a verdict or removing the hold - and removing it (or discarding)
    // retires the review with the close, so no orphan either way.
    const review = holding.length === 1 ? holding[0] : undefined;
    const text =
      review &&
      review.parentId === id &&
      TaskService.isDeliveryChild(review) &&
      review.shape?.kind === "review"
        ? `Cannot close ${task.key} while its review ${refName(settleRef(review, review.id))} is still open: wait for the verdict, steer a re-review at the current head, or remove the hold with link_tasks remove (closing ${task.key} then retires the review with it).`
        : `Cannot close ${task.key} while ${holding.length === 1 ? "it waits on" : `it waits on ${holding.length} tasks`}: ${names}. Merge ${them} first, drop ${them} if the work is not wanted, or remove the wait with link_tasks remove.`;
    return { refused: "waits-on", task, tasks: blockers, ways, text };
  }

  // ---- writes -------------------------------------------------------------

  create(input: CreateTaskInput): TaskRecord {
    const at = input.createdAt ?? this.now();
    const actor = input.actor ?? "firstmate";
    const run = this.write((): TaskRecord => {
      // A child inherits its parent's project (and repo, unless bound to
      // one of its own) - the hierarchy is intra-project by construction.
      const parent = input.parentId ? this.mustGet(input.parentId) : undefined;
      if (parent && parent.id === input.id) {
        throw new TaskGraphRefusal("A task cannot be its own parent.");
      }
      const repoId = input.repoId ?? parent?.repoId ?? null;
      const project = parent
        ? this.projects.get(parent.projectId)
        : input.projectId
          ? this.projects.get(input.projectId)
          : this.resolveProject(repoId);
      if (!project) throw new Error(`Unknown project "${input.projectId}".`);
      const { seq, key } = this.projects.allocateSeq(project.id);
      const status = input.status ?? "open";
      const record: TaskRecord = {
        id: input.id,
        key,
        seq,
        projectId: project.id,
        parentId: parent?.id ?? null,
        kind: input.kind ?? "work",
        title: input.title,
        goal: input.goal ?? input.intent?.goal ?? null,
        intent: input.intent ?? null,
        prompt: input.prompt,
        repoId,
        repoDir: "",
        worktreeDir: "",
        branch: "",
        sessionFile: null,
        accountId: null,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        difficulty: input.difficulty ?? null,
        shape: input.gate
          ? {
              ...(input.shape ?? { kind: "unclear" as const }),
              start_wait_since: {
                ...input.shape?.start_wait_since,
                gate: at,
              },
            }
          : (input.shape ?? null),
        gate: input.gate ?? null,
        status,
        activity: status === "active" ? (input.activity ?? "starting") : null,
        closedReason: null,
        priority: input.priority ?? 2,
        startPolicy: input.startPolicy ?? "when-ready",
        workspaceState: "none",
        outcome: null,
        outcomeSummary: null,
        delivery: null,
        assignee: null,
        model: null,
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        closedAt: null,
      };
      // The shape's relationships are recorded through their checks, after the row.
      const { shape: stored, named } = splitReferences(record.shape);
      const targets = named.map(([kind, ref]) => [kind, ref, this.resolve(ref)] as const);
      this.store.insert({ ...record, shape: stored });
      for (const [kind, ref, target] of targets)
        this.recordReference(record, kind, ref, target, actor, at);
      this.touch(record.id);
      // The insert writes the fixed columns; the computer rides the same
      // write as a patch, so one change carries the row and its placement.
      if (input.deviceId) this.patch(record.id, { deviceId: input.deviceId });
      this.addEvent({
        taskId: record.id,
        at,
        actor,
        kind: "created",
        text: `created "${record.title}"`,
        data: {
          key,
          kind: record.kind,
          status,
          ...(parent ? { parentId: parent.id, parentKey: parent.key } : {}),
        },
        feed: false,
      });
      for (const blockerId of input.blockedBy ?? []) {
        this.insertLink(blockerId, record.id, "blocks", actor, at);
      }
      return record;
    });
    return run();
  }

  // ---- graph writes (P2) --------------------------------------------------

  /** Edit the plain fields of a record; one `note` event lists what changed. */
  policiesOf(record: TaskRecord) {
    return effectiveTaskPolicies(
      record,
      record.repoId ? this.options.repos?.get(record.repoId) : undefined,
    );
  }

  updateFields(id: string, patch: UpdateTaskPatch, actor: TaskEventActor): string[] {
    const at = this.now();
    const run = this.write((): string[] => {
      let record = this.mustGet(id);
      const changes: string[] = [];
      const from = patch.direction?.trim() ? `, from ${patch.direction.trim().slice(0, 80)}` : "";
      if (patch.correctRequiredAction) {
        const action = record.delivery?.captainAction;
        if (
          !action ||
          record.status !== "done" ||
          (action.state !== "confirmed" && action.state !== "checked")
        )
          throw new TaskGraphRefusal("Only a completed required action can be corrected.");
        this.patch(id, {
          status: "open",
          closedAt: null,
          closedReason: null,
          gate: { kind: "captain", ref: action.cardId },
          delivery: this.mergeDelivery(record, {
            captainAction: {
              ...action,
              state: "blocked",
              generation: action.generation + 1,
              completedAt: undefined,
            },
          }),
          updatedAt: at,
        });
        this.addEvent({
          taskId: id,
          at,
          actor,
          kind: "note",
          text: "The captain corrected the earlier confirmation. This does not reverse work that already continued.",
          data: { previous: action },
          feed: true,
        });
        changes.push("required action reopened; previous confirmation kept in history");
        record = this.mustGet(id);
      }
      if (patch.project !== undefined) {
        const project = this.projects.byKey(patch.project) ?? this.projects.get(patch.project);
        if (!project) throw new TaskGraphRefusal(`Unknown project "${patch.project}".`);
        const moved = this.moveToProject(id, project.id, actor);
        if (moved.key !== record.key) changes.push(`moved to ${project.name} as ${moved.key}`);
        record = this.mustGet(id);
      }
      if (patch.parent !== undefined) {
        const parent = patch.parent.trim() ? this.resolve(patch.parent.trim()) : undefined;
        if (patch.parent.trim() && !parent)
          throw new TaskGraphRefusal(`Unknown parent "${patch.parent}".`);
        this.setParent(id, parent?.id ?? null, actor);
        changes.push(parent ? `parent ${parent.key || parent.id}` : "parent cleared");
        record = this.mustGet(id);
      }
      if (
        patch.basis !== undefined &&
        (record.status !== "open" ||
          record.startedAt !== null ||
          record.placement ||
          record.kind !== "work")
      ) {
        throw new TaskGraphRefusal("A basis can only change on open work that has not started.");
      }
      if (
        patch.internalStep !== undefined &&
        (record.status !== "open" ||
          record.startedAt !== null ||
          record.placement ||
          record.kind !== "work")
      ) {
        throw new TaskGraphRefusal(
          "internal_step can only change on open work that has not started.",
        );
      }
      if (
        (patch.resultSchema !== undefined || patch.branchFrom !== undefined) &&
        (record.status !== "open" ||
          record.startedAt !== null ||
          record.placement ||
          record.kind !== "work")
      ) {
        throw new TaskGraphRefusal(
          "A result shape or branch_from can only change on open work that has not started.",
        );
      }

      if (
        patch.programBound !== undefined &&
        (record.status !== "open" ||
          !record.shape?.program ||
          !Number.isInteger(patch.programBound) ||
          patch.programBound < 1)
      ) {
        throw new TaskGraphRefusal(
          "program_bound changes only an open program's bound, to a whole number of at least 1.",
        );
      }
      if (
        patch.speed !== undefined &&
        (record.kind !== "work" || record.status === "done" || record.status === "dropped")
      ) {
        throw new TaskGraphRefusal("Crew speed can only change on unfinished work.");
      }
      if (patch.model !== undefined && (record.status !== "open" || record.kind !== "work")) {
        throw new TaskGraphRefusal(
          "A model can only be named on open work that no crewmate has taken.",
        );
      }
      if (patch.reasoning !== undefined && (record.status !== "open" || record.kind !== "work")) {
        throw new TaskGraphRefusal(
          "A reasoning effort can only be named on open work that no crewmate has taken.",
        );
      }

      if (
        patch.runsOn !== undefined &&
        (record.status !== "open" || record.placement || record.kind !== "work")
      ) {
        throw new TaskGraphRefusal(
          "Where a task runs can change only before it starts; a started task finishes where it started.",
        );
      }

      const update: Parameters<TaskStore["update"]>[1] = {};
      // Relationships change through their checks once the row is written.
      const referenceEdits: [TaskReferenceKind, string | undefined, TaskRecord | undefined][] = [];
      if (patch.placementRequirements !== undefined) {
        if (
          record.status !== "open" ||
          record.kind !== "work" ||
          record.branch ||
          record.sessionFile ||
          record.placement
        )
          throw new TaskGraphRefusal(
            "Computer requirements can change only before the task starts.",
          );
        const { placement_requirements: _old, ...shape } = record.shape ?? {
          kind: "unclear" as const,
        };
        update.shape = {
          ...shape,
          ...(patch.placementRequirements
            ? {
                placement_requirements: placementRequirementsSchema.parse(
                  patch.placementRequirements,
                ),
              }
            : {}),
        };
        changes.push("computer requirements updated");
      }
      if (patch.basis !== undefined) {
        const basis = patch.basis.trim() ? this.resolve(patch.basis.trim()) : undefined;
        if (patch.basis.trim() && !basis)
          throw new TaskGraphRefusal(`Unknown basis "${patch.basis}".`);
        if (basis?.id === id) throw new TaskGraphRefusal("A task cannot be its own basis.");
        const ref = basis ? basis.key || basis.id : undefined;
        if (ref !== record.shape?.basis) {
          referenceEdits.push(["basis", ref, basis]);
          changes.push(ref ? `basis ${ref}` : "basis cleared");
        }
      }
      if (patch.resultSchema !== undefined) {
        const { result_schema: _oldSchema, ...shape } = update.shape ??
          record.shape ?? { kind: "unclear" as const };
        update.shape = {
          ...shape,
          ...(patch.resultSchema ? { result_schema: patch.resultSchema } : {}),
        };
        changes.push(patch.resultSchema ? "result shape set" : "result shape cleared");
      }
      if (patch.internalStep !== undefined) {
        const { internal_step: _oldStep, ...shape } = update.shape ??
          record.shape ?? { kind: "unclear" as const };
        if (patch.internalStep !== (record.shape?.internal_step === true)) {
          update.shape = { ...shape, ...(patch.internalStep ? { internal_step: true } : {}) };
          changes.push(patch.internalStep ? "marked an internal step" : "internal step cleared");
        }
      }
      if (patch.branchFrom !== undefined) {
        const branchFrom = patch.branchFrom.trim() || undefined;
        if (branchFrom !== record.shape?.branch_from) {
          referenceEdits.push([
            "branch-source",
            branchFrom,
            branchFrom ? this.resolve(branchFrom) : undefined,
          ]);
          changes.push(branchFrom ? `branches from ${branchFrom}` : "branch_from cleared");
        }
      }
      if (patch.programBound !== undefined) {
        const current = update.shape ?? record.shape;
        if (current?.program && current.program.bound !== patch.programBound) {
          update.shape = { ...current, program: { ...current.program, bound: patch.programBound } };
          changes.push(`bound ${patch.programBound}`);
        }
      }
      if (patch.speed !== undefined) {
        const { override_speed: _oldSpeed, ...shape } = update.shape ??
          record.shape ?? { kind: "unclear" as const };
        update.shape = {
          ...shape,
          ...(patch.speed === null ? {} : { override_speed: patch.speed }),
        };
        const words =
          patch.speed === null
            ? "crew speed follows the model default"
            : `crew speed ${patch.speed}`;
        changes.push(`${words}${from}`);
      }
      if (patch.reasoning !== undefined) {
        const reasoning = patch.reasoning ?? undefined;
        const current = update.shape ?? record.shape;
        if (reasoning !== current?.override_reasoning) {
          const { override_reasoning: _oldReasoning, ...shape } = current ?? {
            kind: "unclear" as const,
          };
          update.shape = { ...shape, ...(reasoning ? { override_reasoning: reasoning } : {}) };
          const words = reasoning
            ? `reasoning ${reasoningWord({ level: reasoning }).toLowerCase()}`
            : "reasoning follows Models";
          changes.push(`${words}${from}`);
        }
      }
      if (patch.model !== undefined) {
        const model = patch.model.trim() || undefined;
        const current = update.shape ?? record.shape;
        if (model !== current?.override_model_id) {
          // The rest of the shape stays: only the model the captain named
          // changes, and with it the tier the record computes from it. A
          // kind skipped only because a model was named is asked for again
          // once none is.
          const {
            override_model_id: _oldModel,
            placement_fallback_accepted: _oldAcceptance,
            ...shape
          } = current ?? {
            kind: "unclear" as const,
            override_model_id: undefined,
          };
          update.shape = {
            ...shape,
            ...(model ? { override_model_id: model } : {}),
            ...(!model && shape.kind_source === `${KIND_SOURCE.skipped}override`
              ? { kind_source: "none" }
              : {}),
          };
          update.difficulty = tierFor(update.shape).bucket ?? null;
          changes.push(`${model ? `model ${model}` : "model cleared"}${from}`);
        }
      }
      if (patch.runsOn !== undefined) {
        const ask = patch.runsOn.ask ?? undefined;
        const current = update.shape ?? record.shape;
        if (ask !== current?.runs_on_ask) {
          const { runs_on_ask: _oldAsk, ...shape } = current ?? {
            kind: "unclear" as const,
            runs_on_ask: undefined,
          };
          update.shape = { ...shape, ...(ask ? { runs_on_ask: ask } : {}) };
          changes.push(`Runs on: ${patch.runsOn.words}${from}`);
        }
      }
      if (patch.policies && Object.keys(patch.policies).length > 0) {
        if (TaskService.isClosed(record) || !this.policiesOf(record)) {
          throw new TaskGraphRefusal(
            `Policies can only change on open work that ships a change; answers, reviews and the personal workspace have no merge policy. ${fixedHoldWords("nothing-to-merge")}`,
          );
        }
        const shape = update.shape ?? record.shape ?? { kind: "unclear" as const };
        const policies = {
          ...shape.policies,
          ...patch.policies,
          revision: (shape.policies?.revision ?? 0) + 1,
        };
        update.shape = { ...shape, policies };
        const next = this.policiesOf({ ...record, shape: update.shape });
        if (!next) throw new TaskGraphRefusal("This task has no delivery policies.");
        for (const key of ["delivery", "autonomy", "rigor"] as const) {
          if (patch.policies[key] === undefined) continue;
          const value =
            key === "delivery"
              ? POLICY_DELIVERY_WORDS[next.delivery.value]
              : key === "autonomy"
                ? POLICY_MERGING_WORDS[next.autonomy.value ? "on" : "off"]
                : CARE_WORDS[next.rigor.value];
          changes.push(
            `${key === "autonomy" ? "Merging" : key === "rigor" ? "Care" : "Delivery"}: ${value} (${POLICY_SOURCE_WORDS[next[key].source]})${from}`,
          );
        }
        if (next.rigor.requested !== next.rigor.value) changes.push(POLICY_CARE_BOUND);
        // Only the host-owned review edge follows care; unrelated blockers stay.
        for (const child of this.children(id)) {
          if (
            child.shape?.kind !== "review" ||
            !TaskService.isDeliveryChild(child) ||
            TaskService.isClosed(child)
          )
            continue;
          if (next.rigor.value === "reviewed") this.link(child.id, id, "blocks", actor, true);
          else this.unlink(child.id, id, "blocks", actor);
        }
        // Cancel pending attempts in this same transaction. The revision also
        // invalidates attempts already reading asynchronous checks.
        const cancel =
          patch.policies.delivery !== undefined ||
          (patch.policies.autonomy !== undefined && !next.autonomy.value);
        const approval = record.delivery?.mergeAuthorization;
        if (cancel) {
          update.pendingSettle = null;
          if (approval?.status === "standing") {
            update.delivery = this.mergeDelivery(record, {
              mergeAuthorization: {
                ...approval,
                status: "invalidated",
                endedAt: at,
                generation: approval.generation + 1,
                reason: "the task's policy changed",
                // Policy reversal is not an explicit withdrawal hold.
                attempt: undefined,
                retryAt: undefined,
                waiting: undefined,
              },
            });
          }
        }
      }
      if (patch.title !== undefined && patch.title !== record.title) {
        update.title = patch.title;
        changes.push(`title "${patch.title}"`);
      }
      if (
        patch.goal !== undefined &&
        (patch.goal !== record.goal ||
          (record.intent && record.intent.goal !== (patch.goal ?? patch.title ?? record.title)))
      ) {
        update.goal = patch.goal;
        // Goal edits amend host scope, never the captain's verbatim words.
        // Both intent and the stored template must change in this transaction.
        if (record.intent)
          update.intent = { ...record.intent, goal: patch.goal ?? patch.title ?? record.title };
        const previousGoal = record.intent?.goal ?? record.goal;
        if (previousGoal != null) {
          update.prompt = amendBriefGoal(
            record.prompt,
            previousGoal,
            patch.goal ?? patch.title ?? record.title,
            record.intent?.userWords,
          );
        }
        changes.push(patch.goal ? `goal "${patch.goal}"` : "goal cleared");
      }
      if (patch.priority !== undefined && patch.priority !== record.priority) {
        update.priority = patch.priority;
        changes.push(`priority ${patch.priority}`);
      }
      if (patch.startPolicy !== undefined && patch.startPolicy !== record.startPolicy) {
        update.startPolicy = patch.startPolicy;
        changes.push(`start policy ${patch.startPolicy}`);
      }
      if (patch.verdict !== undefined) {
        const verdict = patch.verdict?.trim().slice(0, 280) || null;
        if (verdict !== (record.verdict ?? null)) {
          update.verdict = verdict;
          changes.push(verdict ? `verdict "${verdict}"` : "verdict cleared");
        }
      }
      if (changes.length === 0) return changes;
      // A reference is read with the shape, so a task gains one before its first.
      if (referenceEdits.some(([, ref]) => ref) && !update.shape && !record.shape)
        update.shape = { kind: "unclear" };
      this.patch(id, { ...update, updatedAt: at });
      for (const [kind, ref, target] of referenceEdits) {
        if (ref) this.recordReference(this.mustGet(id), kind, ref, target, actor, at);
        else this.references.delete(id, kind);
      }
      this.addEvent({
        taskId: id,
        at,
        actor,
        kind: "note",
        text: update.verdict ? update.verdict : `updated: ${changes.join(", ")}`,
        data: {
          changes: patch,
          ...(("goal" in update || "prompt" in update || "intent" in update) &&
          this.store.specifications.exists()
            ? { specificationRevision: this.store.specifications.revision(id), journal: true }
            : {}),
          ...(update.verdict ? { ledger: "verdict" } : {}),
          news: true,
        },
        feed: Boolean(update.verdict || patch.policies || patch.runsOn),
      });
      return changes;
    });
    return run();
  }

  /**
   * One parent per task (design section 7). The ancestor walk from the new
   * parent must not reach the task (a cycle), and a child lives in its
   * parent's project: a task already in another project moves only while
   * it is open with no workspace, else the re-parent is refused.
   */
  setParent(id: string, parentId: string | null, actor: TaskEventActor): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.mustGet(id);
      // The parent edge IS the review-to-builder join (captain-approved
      // fold of `review_of`, 2026-09-19): an edit here would silently sever
      // the verdict path, so delivery machinery keeps the parent the host
      // gave it.
      if (TaskService.isDeliveryChild(record) && record.parentId !== parentId) {
        throw new TaskGraphRefusal(
          `Refused: ${record.key || id} is the host's own delivery work under ${record.parentId ?? "its builder"}; its parent is fixed.`,
        );
      }
      if (parentId === null) {
        if (record.parentId === null) return;
        this.patch(id, { parentId: null, updatedAt: at });
        this.addEvent({
          taskId: id,
          at,
          actor,
          kind: "moved",
          text: "no longer under a parent",
          data: { parentId: null, previousParentId: record.parentId },
          feed: false,
        });
        return;
      }
      if (parentId === id) throw new TaskGraphRefusal("A task cannot be its own parent.");
      const parent = this.mustGet(parentId);
      if (record.parentId === parentId) return;
      if (this.ancestors(parentId).some((ancestor) => ancestor.id === id)) {
        throw new TaskGraphRefusal(
          `Refused: ${parent.key || parentId} is already under ${record.key || id}; making it the parent would close a cycle.`,
        );
      }
      if (parent.projectId !== record.projectId) {
        this.moveWithin(record, parent.projectId, actor, at, parent.repoId);
      }
      this.patch(id, { parentId, updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor,
        kind: "moved",
        text: `now under "${parent.title}" (${parent.key || parent.id})`,
        data: { parentId, previousParentId: record.parentId },
        ref: parentId,
        feed: false,
      });
    });
    run();
  }

  /**
   * Move an open, workspace-less task to another project: a new key is
   * minted there (the old one is retired, never reused) and a `moved`
   * event carries both. Children follow their parent's project, so the
   * subtree moves with it, into this project's repository when it has one,
   * except a part bound to a repository of its own (`moveWithin`).
   */
  moveToProject(id: string, projectId: string, actor: TaskEventActor): TaskRecord {
    const at = this.now();
    const run = this.write((): TaskRecord => {
      const record = this.mustGet(id);
      if (record.projectId !== projectId) this.moveWithin(record, projectId, actor, at);
      return this.mustGet(id);
    });
    return run();
  }

  /**
   * A crewmate's line onto its own timeline; never a feed line. With `plan`,
   * the note also carries the whole list the crewmate reports (FI3-734), in
   * the event's data: the newest such note is the task's plan, read off the
   * timeline, never stored twice.
   */
  noteProgress(
    id: string,
    text: string,
    actor: TaskEventActor = "crewmate",
    plan?: readonly PlanItem[],
    /** Facts the line's writer reads back, such as a program's count of its lines. */
    facts?: Record<string, unknown>,
  ): void {
    const at = this.now();
    const run = this.write(() => {
      this.mustGet(id);
      this.patch(id, { updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor,
        kind: "progress",
        text,
        ...(plan || facts
          ? { data: { ...facts, ...(plan ? { plan: plan.map((item) => ({ ...item })) } : {}) } }
          : {}),
        feed: false,
      });
    });
    run();
  }

  /**
   * A follow-up the crewmate found (design section 7, `file_followup`): a
   * task of its own, discovered-from its origin, open and on request - the
   * Firstmate decides when it runs. It is deliberately NOT a child of the
   * origin: discovery is provenance, and a parent edge would make every
   * filed follow-up a silent gate on the origin's close. `blocksOrigin`
   * records a real dependency, and only that gates the origin.
   */
  fileFollowup(input: FileFollowupInput): FileFollowupResult {
    const at = this.now();
    const actor = input.actor ?? "crewmate";
    const testPath = input.testPath ? normalizeTestPath(input.testPath) : undefined;
    if (input.testFailure && !testPath) {
      throw new Error("test_path is required when the follow-up is a test failure.");
    }
    const run = this.write((): FileFollowupResult => {
      if (testPath) {
        const existing = this.store.openByTestPath(testPath);
        if (existing) return { record: existing, duplicate: true };
      }
      const origin = this.mustGet(input.originId);
      const record = this.create({
        id: input.id,
        kind: "work",
        title: input.title,
        goal: input.goal,
        prompt: input.prompt,
        repoId: origin.repoId,
        // No parentId: the discovered-from edge below is the whole
        // relationship. A child would gate the origin's close.
        projectId: origin.projectId,
        startPolicy: "on-request",
        actor,
        createdAt: at,
      });
      if (testPath) this.patch(record.id, { testPath });
      this.insertLink(record.id, origin.id, "discovered-from", actor, at);
      this.addEvent({
        taskId: record.id,
        at,
        actor,
        kind: "note",
        text: `filed while working on "${origin.title}" (${origin.key || origin.id}): ${input.why}`,
        data: { why: input.why, originId: origin.id, news: true },
        ref: origin.id,
        feed: false,
      });
      if (input.blocksOrigin) this.insertLink(record.id, origin.id, "blocks", actor, at, true);
      return { record: this.mustGet(record.id), duplicate: false };
    });
    return run();
  }

  /**
   * The origin a crewmate filed this row from. A discovered-from edge whose
   * actor is not a crewmate is not a filing the ledger counts.
   */
  crewFilingOrigin(id: string): TaskRecord | undefined {
    const link = this.links
      .listFrom(id, "discovered-from")
      .find((edge) => edge.actor === "crewmate");
    return link ? this.store.get(link.toId) : undefined;
  }

  /**
   * The captain opened the record. Clears the Charted "new" mark. Idempotent
   * and silent: opening is not a verdict, so it writes no feed line.
   */
  markOpened(id: string, at = this.now()): boolean {
    const run = this.write((): boolean => {
      const record = this.mustGet(id);
      if (!this.crewFilingOrigin(id) || record.captainOpenedAt != null) return false;
      this.patch(id, { captainOpenedAt: at, updatedAt: at });
      return true;
    });
    return run();
  }

  /**
   * Drop an open row and, with the captain's confirm, its open descendants
   * as superseded (design section 7). Rows a crewmate holds are never
   * touched here - the supervisor's settle path owns those - so the caller
   * checks `closeRefusal` and the descendants' states first. `replacedBy`
   * names the task that does its work instead: a `replaced-by` link is
   * written before the close, so the close and that task's milestones reach
   * whatever the dropped one concerned (FI3-1189's rule 1).
   */
  dropWithChildren(
    id: string,
    input: { reason: string; actor: TaskEventActor; text?: string; replacedBy?: string },
  ): TaskRecord[] {
    const run = this.write((): TaskRecord[] => {
      const record = this.mustGet(id);
      const replacement = input.replacedBy ? this.mustGet(input.replacedBy) : undefined;
      if (replacement) {
        const refusal = this.carrierRefusal(id, replacement.id);
        if (refusal) throw new TaskGraphRefusal(refusal);
        this.insertLink(id, replacement.id, "replaced-by", input.actor, this.now());
      }
      const dropped: TaskRecord[] = [];
      // Deepest first, so every parent closes after its children.
      for (const descendant of this.descendants(id).reverse()) {
        if (descendant.status !== "open") continue;
        this.close(descendant.id, {
          status: "dropped",
          reason: "superseded",
          actor: input.actor,
          text: `superseded - "${record.title}" (${record.key || record.id}) was dropped`,
        });
        dropped.push(this.mustGet(descendant.id));
      }
      // Work another task carries on closes done through it (INF-1825):
      // the drop's word is kept for work nobody carries on.
      if (replacement) {
        this.close(id, carriedOnClose(replacement, input.actor));
        return dropped;
      }
      // The first mate's reason is its closing sentence (INF-547): what
      // Activity's line for the drop says.
      const closingSentence = input.actor === "firstmate" ? input.reason.trim() : "";
      this.close(id, {
        status: "dropped",
        reason: "cancelled",
        actor: input.actor,
        text: input.text ?? `dropped - ${input.reason}`,
        ...(closingSentence ? { data: { closingSentence } } : {}),
      });
      return dropped;
    });
    return run();
  }

  /**
   * What Drop task would affect, named the way the confirmation shows it.
   * Open and active descendants are parts (refused, not dropped). Waiting
   * and underway are external tasks this one blocks; neither is changed.
   */
  dropEffects(id: string): DropEffects {
    const byKey = (left: { key: string }, right: { key: string }) =>
      left.key.localeCompare(right.key);
    const parts = this.descendants(id)
      .filter((descendant) => descendant.status === "open" || descendant.status === "active")
      .map((descendant) => ({
        key: descendant.key || descendant.id,
        title: descendant.title,
        started: descendant.status === "active" || descendant.startedAt != null,
      }))
      .sort(byKey);
    const waiting = [];
    const underway = [];
    for (const dependent of this.blocking(id)) {
      const named = { key: dependent.key || dependent.id, title: dependent.title };
      if (dependent.status === "open") waiting.push(named);
      else if (dependent.status === "active") underway.push(named);
    }
    return { parts, waiting: waiting.sort(byKey), underway: underway.sort(byKey) };
  }

  /**
   * Drop never-started work the captain no longer wants. Refuses open
   * parts, a row that has started, and a review that no longer matches.
   * Does not touch descendants, links, or dependents. One transaction.
   */
  dropUnstarted(
    id: string,
    input: {
      actor: TaskEventActor;
      review: DropTaskReview;
      reason?: string;
      via?: typeof TASK_CARD_VIA;
      /** The panel the captain dropped it from, by its title. */
      panel?: string;
    },
  ): { ok: true } | { ok: false; text: string } {
    const run = this.write((): { ok: true } | { ok: false; text: string } => {
      const record = this.store.get(id);
      if (!record) return { ok: false, text: dropMissingRefusal(id) };
      const key = record.key || record.id;
      if (!isUnstartedWork(record) || record.worktreeDir || record.assignee != null) {
        return { ok: false, text: dropIneligibleRefusal(key) };
      }
      const effects = this.dropEffects(id);
      if (effects.parts.length > 0) {
        return { ok: false, text: dropPartsRefusal(key, effects.parts) };
      }
      if (!sameDropReview(dropReviewKeys(effects), input.review)) {
        return { ok: false, text: DROP_REVIEW_STALE };
      }
      this.close(id, {
        status: "dropped",
        reason: "cancelled",
        actor: input.actor,
        text: `dropped - ${input.reason ?? NO_LONGER_WANTED}`,
        data: {
          [DROP_BEFORE_START]: true,
          ...(input.via ? { via: input.via } : {}),
          ...(input.panel ? { panel: input.panel } : {}),
        },
        feed: false,
      });
      return { ok: true };
    });
    return run();
  }

  /**
   * The task board's queue and unqueue (src/shared/taskQueue.ts): never-
   * started work starts by itself when ready, or waits for the captain's
   * word again. Work that has started, a parent whose parts do the work, and
   * closed or missing rows are refused as text and nothing is written. The
   * start policy is the one field it writes - blockers, holds, priority,
   * order, project and parent stay - with one timeline entry in the
   * captain's words. `changed` is false when the row already had it.
   */
  setQueued(
    id: string,
    op: keyof typeof QUEUE_POLICY,
    input: { actor: TaskEventActor; via?: typeof TASK_CARD_VIA; panel?: string },
  ): { ok: true; changed: boolean } | { ok: false; text: string } {
    const run = this.write((): { ok: true; changed: boolean } | { ok: false; text: string } => {
      const record = this.store.get(id);
      if (!record) return { ok: false, text: queueMissingRefusal(id) };
      const key = record.key || record.id;
      if (record.kind !== "work" || record.status !== "open") {
        return { ok: false, text: queueClosedRefusal(key) };
      }
      if (!isUnstartedWork(record) || record.worktreeDir || record.assignee != null) {
        return { ok: false, text: queueStartedRefusal(key) };
      }
      if (this.children(id).length > 0) return { ok: false, text: queuePartsRefusal(key) };
      const startPolicy = QUEUE_POLICY[op];
      if (record.startPolicy === startPolicy) return { ok: true, changed: false };
      const at = this.now();
      this.patch(id, {
        startPolicy,
        ...(record.startNotice ? { startNotice: null } : {}),
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "note",
        text: op === "queue-task" ? QUEUED_ACTIVITY : UNQUEUED_ACTIVITY,
        data: {
          startPolicy,
          ...(input.via ? { via: input.via } : {}),
          ...(input.panel ? { panel: input.panel } : {}),
          news: true,
        },
        feed: false,
      });
      return { ok: true, changed: true };
    });
    return run();
  }

  /**
   * A crewmate takes the task: workspace, account, assignee, model. Shared
   * by an immediate commission and the ready sweep's dispatch.
   */
  /**
   * Take an open work row out of the ready query before any await on the
   * start path. Returns false when another caller already claimed it or
   * the row is not open work. `dispatch` later fills workspace facts;
   * `requeue` returns a failed start to the queue.
   */
  /**
   * Accepted starts that have not been claimed yet. The board reads this so
   * both surfaces leave Backlog before classification and routing finish.
   * Lost on restart: the row is still open, which is not a confirmed failure.
   */
  private readonly startAttempts = new Map<
    string,
    { phase: "preparing" | "checking"; since: number }
  >();

  startAttemptOf(id: string): { phase: "preparing" | "checking"; since: number } | undefined {
    return this.startAttempts.get(id);
  }

  startAttemptIds(): readonly string[] {
    return [...this.startAttempts.keys()];
  }

  /** Publish a start before the first slow step. Clears a previous failure notice. */
  beginStartAttempt(id: string): boolean {
    const run = this.write(() => {
      const record = this.store.get(id);
      if (record?.status !== "open" || record.kind !== "work") return false;
      const at = this.now();
      this.startAttempts.set(id, { phase: "preparing", since: at });
      if (record.startNotice) this.patch(id, { startNotice: null, updatedAt: at });
      else this.touch(id);
      return true;
    });
    return run();
  }

  /** The attempt is claimed, refused, or no longer the thing the board should preview. */
  clearStartAttempt(id: string): void {
    if (!this.startAttempts.has(id)) return;
    const run = this.write(() => {
      this.startAttempts.delete(id);
      this.touch(id);
    });
    run();
  }

  /** Contact was lost after the attempt was accepted. Not a confirmed failure. */
  markStartChecking(id: string): void {
    const run = this.write(() => {
      const since = this.startAttempts.get(id)?.since ?? this.now();
      this.startAttempts.set(id, { phase: "checking", since });
      this.touch(id);
    });
    run();
  }

  /**
   * Contact came back and no session was recorded. Back to open, no failure
   * notice: an unknown outcome is not a confirmed failure.
   */
  releaseUnconfirmedStart(id: string): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record || record.status === "done" || record.status === "dropped") return;
      this.startAttempts.delete(id);
      if (record.status !== "active" || record.worktreeDir || record.sessionFile) return;
      this.patch(id, {
        status: "open",
        activity: null,
        assignee: null,
        model: null,
        startedAt: null,
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "status",
        text: "returned to the queue - the start was not confirmed",
        feed: false,
      });
    });
    run();
  }

  /**
   * A program began running in the host's runner (INF-799). It stays open,
   * since no crewmate holds it, and its first run is one event on its
   * timeline - never startedAt, which says a crewmate started and draws the
   * Crewmate tab - so a Start on request reads as started and the sweep
   * runs it again after a quit.
   */
  markProgramStarted(id: string): void {
    const run = this.write(() => {
      this.mustGet(id);
      if (this.programStarted(id)) return;
      const at = this.now();
      this.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "status",
        text: "program started",
        data: { programStarted: true, journal: true },
      });
    });
    run();
  }

  /** Whether the host's runner has run this program task (markProgramStarted). */
  programStarted(id: string): boolean {
    return this.timeline(id).some((event) => event.data?.programStarted === true);
  }

  /**
   * A confirmed manual start did not begin. Back to open, start policy kept,
   * the reason stored so a reopened view still says why.
   */
  failManualStart(id: string, reason: string): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record || record.status === "done" || record.status === "dropped") return;
      this.startAttempts.delete(id);
      this.patch(id, {
        status: "open",
        activity: null,
        gate: null,
        worktreeDir: "",
        branch: "",
        workspaceState: "none",
        assignee: null,
        model: null,
        startedAt: null,
        startNotice: JSON.stringify({ reason }),
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "status",
        text: `could not start - ${reason}`,
        data: { startNotice: { reason } },
        feed: false,
      });
    });
    run();
  }

  claimForDispatch(id: string, from?: typeof TASK_CARD_VIA, panel?: string): boolean {
    const run = this.write(() => {
      const record = this.mustGet(id);
      if (record.status !== "open" || record.kind !== "work") return false;
      const at = this.now();
      this.patch(id, {
        status: "active",
        activity: "starting",
        gate: null,
        startedAt: record.startedAt ?? at,
        updatedAt: at,
      });
      // The captain's Start on the task card is his, and says where it came from.
      this.addEvent({
        taskId: id,
        at,
        actor: from ? "captain" : "host",
        kind: "status",
        text: "starting",
        ...(from ? { data: { via: from, ...(panel ? { panel } : {}) } } : {}),
      });
      return true;
    });
    return run();
  }

  dispatch(id: string, input: DispatchInput): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.mustGet(id);
      const model = input.model ? `${input.model.provider}/${input.model.id}` : null;
      this.patch(id, {
        status: "active",
        activity: "starting",
        closedReason: null,
        closedAt: null,
        gate: null,
        repoDir: input.workspace.repoDir,
        worktreeDir: input.workspace.worktreeDir,
        branch: input.workspace.branch,
        workspaceState:
          input.workspace.worktreeDir || input.workspace.elsewhere ? "present" : "none",
        accountId: input.accountId,
        assignee: input.assignee,
        model,
        startedAt: record.startedAt ?? at,
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "host",
        kind: "dispatched",
        text: `${input.assignee} started${model ? ` on ${model}` : ""}`,
        data: {
          assignee: input.assignee,
          model,
          branch: input.workspace.branch,
          ...(model && input.reasoning ? { reasoning: input.reasoning } : {}),
        },
      });
    });
    run();
  }

  /**
   * The model now answering for the task's crewmate, when it is not the one
   * the record names (`CrewSupervisor`, a session's `model_served`): the
   * record names it from here on, and `line`, when given, is the timeline
   * row and feed line that says what moved it.
   */
  recordServedModel(
    id: string,
    model: { provider: string; id: string },
    line?: { text: string; data: Record<string, unknown> },
  ): void {
    const at = this.now();
    const run = this.write(() => {
      this.mustGet(id);
      this.patch(id, { model: `${model.provider}/${model.id}`, updatedAt: at });
      if (line) {
        this.addEvent({
          taskId: id,
          at,
          actor: "host",
          kind: "note",
          text: line.text,
          data: { ...line.data, news: true },
          feed: true,
        });
      }
    });
    run();
  }

  /**
   * A started task moved to another provider between turns (INF-849): the
   * record names the model and account that serve it from here on, and one
   * timeline row and feed line, written as whoever asked, says so. Its key,
   * branch, working copy and history stay.
   */
  recordMove(
    id: string,
    input: {
      model: { provider: string; id: string };
      accountId: string | null;
      actor: "captain" | "firstmate";
      text: string;
      data: Record<string, unknown>;
    },
  ): void {
    const at = this.now();
    const run = this.write(() => {
      this.mustGet(id);
      this.patch(id, {
        model: `${input.model.provider}/${input.model.id}`,
        accountId: input.accountId,
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "note",
        text: input.text,
        data: { ...input.data, news: true },
        feed: true,
      });
    });
    run();
  }

  /**
   * A started task's move to another computer as it stands
   * (docs/helper.md, "Moving a started task"), or null once none does. A
   * `line` is one timeline row, and a feed line with `feed`, written as
   * whoever acted. Its key, branch, working copy and history stay.
   */
  setComputerMove(
    id: string,
    move: ComputerMove | null,
    line?: { text: string; actor: "captain" | "firstmate" | "host"; feed?: boolean },
  ): void {
    const at = this.now();
    this.write(() => {
      const record = this.mustGet(id);
      const { computer_move: _move, ...rest } = record.shape ?? { kind: "unclear" as const };
      this.patch(id, {
        shape: { ...rest, ...(move ? { computer_move: move } : {}) } as WorkShape,
        updatedAt: at,
      });
      if (line)
        this.addEvent({
          taskId: id,
          at,
          actor: line.actor,
          kind: "note",
          text: line.text,
          data: { news: line.feed === true, ...(move ? { computerMove: move } : {}) },
          feed: line.feed === true,
        });
    })();
  }

  /**
   * The one commit of a move to another computer: the record names the
   * computer the task runs on now and its working copy there - a folder
   * here, or none here for a computer that runs work - and the move turns
   * to removing the copy it left. Its start's placement ends: it describes
   * where the task started. Refused for a closed task or one that already
   * runs on `deviceId`.
   */
  commitComputerMove(
    id: string,
    input: {
      deviceId: string | null;
      repoDir: string;
      worktreeDir: string;
      branch: string;
      move: ComputerMove;
      actor: "captain" | "firstmate";
      text: string;
    },
  ): void {
    const at = this.now();
    this.write(() => {
      const record = this.mustGet(id);
      if (TaskService.isClosed(record)) throw new Error("This task is closed.");
      if ((record.deviceId ?? null) === input.deviceId)
        throw new Error("This task already runs on that computer.");
      const { computer_move: _move, ...rest } = record.shape ?? { kind: "unclear" as const };
      this.patch(id, {
        deviceId: input.deviceId,
        placement: null,
        repoDir: input.repoDir,
        worktreeDir: input.worktreeDir,
        branch: input.branch,
        workspaceState: "present",
        shape: { ...rest, computer_move: input.move } as WorkShape,
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "note",
        text: input.text,
        data: { news: true, computerMove: input.move },
        feed: true,
      });
    })();
  }

  /** A dispatch that failed returns the row to the queue behind a gate. */
  requeue(id: string, gate: TaskGate, reason: string): void {
    const at = this.now();
    const run = this.write(() => {
      this.mustGet(id);
      this.patch(id, {
        status: "open",
        activity: null,
        gate,
        repoDir: "",
        worktreeDir: "",
        branch: "",
        workspaceState: "none",
        assignee: null,
        model: null,
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "status",
        text: `returned to the queue - ${reason}`,
        data: { gate },
      });
    });
    run();
  }

  setActivity(id: string, activity: TaskActivity): void {
    const run = this.write(() => this.patch(id, { activity, updatedAt: this.now() }));
    run();
  }

  /**
   * An idle boundary (docs/report-sort.md, "The idle ladder"): the idle
   * clock starts, unless it is already running - the turn the ladder's own
   * nudge started continues its episode instead of opening a new one, and
   * a resume finds the clock its record kept across the restart. A turn
   * the provider failed opens its episode past the nudge: the retry owns
   * that turn's guidance. Machinery, so no timeline event.
   */
  markIdle(id: string, options: { providerFailed?: boolean; at?: number } = {}): void {
    const at = options.at ?? this.now();
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record || record.idleSince != null) return;
      this.patch(id, {
        idleSince: at,
        recoveryRung: options.providerFailed ? 1 : 0,
        recoveryCount: 0,
        recoveryAt: null,
      });
    });
    run();
  }

  /** A turn began that the ladder did not start: the idle episode ends with its rungs. */
  endIdle(id: string): void {
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record) return;
      if (record.idleSince == null && !record.recoveryRung && record.recoveryAt == null) return;
      this.patch(id, { idleSince: null, recoveryRung: 0, recoveryCount: 0, recoveryAt: null });
    });
    run();
  }

  /**
   * One rung of the idle ladder acted (or a record older than the clock got
   * one): the durable rung, wake count, and when. `idleSince` starts a
   * clock the record never had.
   */
  recordRecovery(
    id: string,
    input: { rung: number; count: number; at: number | null; idleSince?: number },
  ): void {
    const run = this.write(() => {
      if (!this.store.get(id)) return;
      this.patch(id, {
        recoveryRung: input.rung,
        recoveryCount: input.count,
        recoveryAt: input.at,
        ...(input.idleSince !== undefined ? { idleSince: input.idleSince } : {}),
      });
    });
    run();
  }

  /**
   * Whether every one of these inbox rows was the idle ladder's own nudge
   * (a `steered` event by the supervisor naming the row): the turn that
   * delivers only those continues the idle episode it belongs to.
   */
  onlyLadderSteers(id: string, inboxIds: readonly number[]): boolean {
    if (inboxIds.length === 0) return false;
    const nudged = new Set(this.events.ladderSteerRows(id));
    return inboxIds.every((row) => nudged.has(row));
  }

  /** The resume pointer and its conversation association commit together. */
  setSessionFile(
    id: string,
    sessionFile: string | null,
    facts?: Omit<TaskSession, "conversation" | "resume_token" | "opened_at" | "last_at">,
  ): void {
    const run = this.write(() => {
      const now = this.now();
      this.mustGet(id);
      if (sessionFile && facts) {
        this.conversations.record(id, {
          ...facts,
          conversation: conversationOf(sessionFile),
          resume_token: sessionFile,
          opened_at: now,
          last_at: now,
        });
      }
      this.patch(id, { sessionFile, updatedAt: now });
      if (sessionFile && facts)
        this.conversations.observe(id, {
          ...facts,
          conversation: conversationOf(sessionFile),
          observed_at: now,
        });
    });
    run();
  }

  /** Durable rows only, for record export without inferred folder metadata. */
  specificationFor(event: TaskEvent) {
    const revision = event.data?.specificationRevision;
    return typeof revision === "number" && this.store.specifications.exists()
      ? this.store.specifications.at(event.taskId, revision)
      : undefined;
  }

  recordedSpecifications(id: string) {
    return this.store.specifications.exists() ? this.store.specifications.history(id) : [];
  }

  sessionObservations(id: string) {
    return this.conversations.observations(id);
  }

  sessionObservation(id: string) {
    return this.conversations.observation(id);
  }

  recordedSessions(id: string): TaskSession[] {
    return this.conversations.list(id);
  }

  /**
   * The recorded conversation a task's resume binding names, for record
   * export (INF-1296 piece 3); null when its token names none.
   */
  recordedConversation(id: string): string | null {
    return this.store.execution.get(id).conversation;
  }

  /** A task's basis, branch source and earlier attempt as recorded, for record export. */
  recordedReferences(id: string): TaskReference[] {
    return this.references.list(id);
  }

  /** Recorded conversations plus unlabelled files retained before the association existed. */
  sessions(id: string, folder?: { dir: string; computer: string }) {
    const task = this.mustGet(id);
    // The resume binding names the conversation it resumes (INF-1296 piece
    // 3); a token from before associations names the one its file is.
    const binding = this.store.execution.get(id);
    const resumes =
      binding.conversation ?? (task.sessionFile ? conversationOf(task.sessionFile) : null);
    const rows: (Omit<TaskSession, "began" | "opened_at" | "last_at" | "resume_token"> & {
      began: string | null;
      opened_at: number | null;
      last_at: number | null;
      current: boolean;
    })[] = this.conversations.list(id).map(({ resume_token, ...session }) => ({
      ...session,
      current: resumes !== null && resumes === conversationOf(resume_token),
    }));
    const known = new Set(rows.map((row) => conversationOf(row.file)));
    for (const file of folder ? sessionFilesIn(folder.dir) : []) {
      const conversation = conversationOf(file);
      if (known.has(conversation)) continue;
      rows.push({
        conversation,
        file,
        computer: folder?.computer ?? null,
        device_id: null,
        provider: null,
        model: null,
        account_id: null,
        opened_at: null,
        last_at: null,
        began: null,
        current: resumes === conversation,
      });
    }
    return rows;
  }

  /**
   * The host's stamp and the tier it computes to (S3), written onto the
   * record as it stands (INF-416 piece F). The stamp carries only the
   * fields the host owns (`HOST_STAMP_FIELDS`); a model, a basis or any
   * other field a person owns stays, including one cleared while the
   * stamp was in flight. Deliberately quiet - a shape explains a routing
   * decision rather than being a state change, and it rides
   * `routing_decisions` for the audit either way.
   */
  recordShape(id: string, stamp: HostStamp, difficulty: TaskRecord["difficulty"]): void {
    const run = this.write(() => {
      const current = this.mustGet(id).shape ?? { kind: "unclear" as const };
      this.patch(id, {
        shape: stampOnto(current, stamp),
        difficulty,
        updatedAt: this.now(),
      });
    });
    run();
  }

  /**
   * The latest Automatic wait, on the record rather than in process memory,
   * so a restart keeps the words and does not say the line again. Not the
   * could-not-start notice. Null clears it once the task is no longer waiting.
   */
  setPlacementWait(id: string, wait: PlacementWait | null): void {
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record) return;
      const shape = record.shape ?? { kind: "unclear" as const };
      const current = shape.placement_wait;
      if (wait === null) {
        if (!current) return;
        const { placement_wait: _wait, ...rest } = shape;
        this.patch(id, { shape: rest, updatedAt: this.now() });
        return;
      }
      if (current?.kind === wait.kind && current.words === wait.words) return;
      this.patch(id, {
        shape: {
          ...shape,
          placement_wait: {
            ...wait,
            since: current?.kind === wait.kind ? (current.since ?? this.now()) : this.now(),
          },
        },
        updatedAt: this.now(),
      });
    });
    run();
  }

  /** Re-binding at a resume attachment point updates the account column. */
  setAccountId(id: string, accountId: string | null): void {
    const run = this.write(() => this.patch(id, { accountId, updatedAt: this.now() }));
    run();
  }

  /** Evaluate against every durable pending reservation and commit in one writer transaction.
   * The callback is synchronous: no preparation or other asynchronous work can interleave.
   */
  commitPlacement(
    id: string,
    choose: (pending: readonly TaskRecord[]) => PlacementSnapshot | undefined,
  ): CommittedPlacement | undefined {
    return this.write(() => {
      const record = this.mustGet(id);
      if (record.placement && record.placement.reservation !== "ended") return record.placement;
      if (TaskService.isClosed(record) || record.branch || record.sessionFile) return undefined;
      const chosen = choose(this.store.pendingPlacements());
      if (!chosen) return undefined;
      const snapshot = placementSnapshotSchema.parse(chosen);
      if (record.placement && snapshot.computerId !== record.placement.snapshot.computerId)
        throw new Error("A committed task cannot move to another computer.");
      const placement: CommittedPlacement = { snapshot, reservation: "pending" };
      this.patch(id, {
        placement,
        deviceId: snapshot.computerId,
        ...(snapshot.acceptedFallback
          ? {
              shape: {
                ...(record.shape ?? { kind: "unclear" as const }),
                placement_fallback_accepted: true,
              },
            }
          : {}),
        updatedAt: this.now(),
      });
      this.addEvent({
        taskId: id,
        at: this.now(),
        actor: "host",
        kind: "note",
        text: placementReason(snapshot),
        data: { news: true },
        feed: true,
      });
      return placement;
    })();
  }

  pendingPlacements(): TaskRecord[] {
    return this.store.pendingPlacements();
  }

  waitForPlacement(id: string, acceptedFallback: boolean, words = PLACEMENT_WAIT): void {
    this.write(() => {
      const record = this.mustGet(id);
      if (record.status !== "open") return;
      const shape = record.shape ?? { kind: "unclear" as const };
      if (
        record.startPolicy === "when-ready" &&
        (!acceptedFallback || shape.placement_fallback_accepted)
      )
        return;
      this.patch(id, {
        startPolicy: "when-ready",
        shape: { ...shape, ...(acceptedFallback ? { placement_fallback_accepted: true } : {}) },
        updatedAt: this.now(),
      });
      this.addEvent({
        taskId: id,
        at: this.now(),
        actor: "host",
        kind: "note",
        text: words,
        feed: false,
      });
    })();
  }

  beginPlacementPreparation(id: string): void {
    this.write(() => {
      const record = this.mustGet(id);
      if (TaskService.isClosed(record)) throw new Error("This task is closed.");
      if (record.placement && !record.placement.preparationStarted)
        this.patch(id, {
          placement: { ...record.placement, preparationStarted: true },
          updatedAt: this.now(),
        });
    })();
  }

  /** Only the placement owner presents evidence of observation or completion. */
  releasePlacement(id: string, orderId: string, evidence: "observed" | "ended"): void {
    this.write(() => {
      const record = this.store.get(id);
      if (
        !record?.placement ||
        record.placement.snapshot.orderId !== orderId ||
        record.placement.reservation !== "pending"
      )
        return;
      this.patch(id, {
        placement: { ...record.placement, reservation: evidence },
        updatedAt: this.now(),
      });
    })();
  }

  /** Bind a computer before its first turn; a committed Automatic choice stays fixed. */
  setDevice(id: string, deviceId: string | null): void {
    this.write(() => {
      const record = this.mustGet(id);
      if (record.placement && record.placement.snapshot.computerId !== deviceId)
        throw new TaskGraphRefusal("A committed task stays on the computer it chose.");
      this.patch(id, { deviceId, updatedAt: this.now() });
    })();
  }

  /**
   * A computer that runs work is being removed: each live task's own Runs
   * on that names it is forgotten, as each project's moves home
   * (docs/helper.md, "A task's own Runs on"). Answers their ids.
   */
  forgetRunsOn(deviceId: string): string[] {
    const at = this.now();
    const run = this.write(() =>
      this.store.listByStatus("open", "active").flatMap((record) => {
        if (!record.shape || record.shape.runs_on_ask !== deviceId) return [];
        const { runs_on_ask: _removed, ...shape } = record.shape;
        this.patch(record.id, { shape, updatedAt: at });
        this.addEvent({
          taskId: record.id,
          at,
          actor: "host",
          kind: "note",
          text: "Runs on: the computer it named was removed, so it runs where its parent or project says",
          data: { news: true },
        });
        return [record.id];
      }),
    );
    return run();
  }

  /** Re-hold an open row (a captain answer routed it to another wait). */
  setGate(id: string, gate: TaskGate | null, text?: string): void {
    const at = this.now();
    const run = this.write(() => {
      this.patch(id, { gate, updatedAt: at });
      if (text) {
        this.addEvent({
          taskId: id,
          at,
          actor: "host",
          kind: "status",
          text,
          data: { gate },
          feed: false,
        });
      }
    });
    run();
  }

  /** A verified release report writes all its same-project attributions together, with provenance. */
  recordFirstRelease(reporterId: string, input: FirstReleaseReport): number {
    const report = firstReleaseReportSchema.parse(input);
    const { tasks: refs, corrects, ...release } = report;
    const at = this.now();
    let recorded = 0;
    const run = this.write(() => {
      const reporter = this.mustGet(reporterId);
      if (!reporter.repoId) throw new TaskGraphRefusal("Release attribution needs a project.");
      const targets = [
        ...new Set(
          refs.map((ref) => {
            const target = this.resolve(ref);
            if (!target) throw new TaskGraphRefusal(`Unknown release task "${ref}".`);
            return target.id;
          }),
        ),
      ].map((id) => this.mustGet(id));
      // Check the entire batch before writing any attribution.
      for (const target of targets) {
        if (target.repoId !== reporter.repoId || target.projectId !== reporter.projectId)
          throw new TaskGraphRefusal("Release tasks must belong to your own project.");
        if (
          target.status !== "done" ||
          (target.closedReason !== "merged" && target.closedReason !== "landed")
        )
          throw new TaskGraphRefusal(`Release task ${target.key || target.id} is not merged work.`);
        if (corrects !== undefined && target.delivery?.firstRelease?.version !== corrects)
          throw new TaskGraphRefusal(
            `Release task ${target.key || target.id} no longer records ${corrects}. Read it before correcting it.`,
          );
      }
      for (const target of targets) {
        const previous = target.delivery?.firstRelease;
        if (previous && corrects === undefined) continue;
        if (JSON.stringify(previous) === JSON.stringify(release)) continue;
        this.patch(target.id, {
          delivery: this.mergeDelivery(target, { firstRelease: release }),
          updatedAt: at,
        });
        this.addEvent({
          taskId: target.id,
          at,
          actor: "crewmate",
          kind: "note",
          text: `First verified release: ${release.version}`,
          data: {
            firstRelease: release,
            ...(previous ? { previousFirstRelease: previous } : {}),
            reportedBy: reporter.id,
          },
        });
        recorded += 1;
      }
    });
    run();
    return recorded;
  }

  /**
   * A turn ended with a report: the outcome columns and a `report` event.
   * The headline is the report's own one-line summary when the crewmate gave
   * one, else its first sentence past any Intent section (`reportSummary`).
   */
  recordReport(
    id: string,
    input: {
      text: string;
      summary?: string;
      actor?: TaskEventActor;
      usage?: Record<string, unknown>;
      /** What the report declared about whose turn follows it (FI3-435). */
      declared?: ReportDeclaration;
    },
  ): void {
    const at = this.now();
    const summary = input.summary?.trim() || reportSummary(input.text) || null;
    const recovery = reportRecoveryOf(input.declared);
    const text = recovery.overflow
      ? `${input.text}\n\nFull recovery details: ${recovery.overflow}`
      : input.text;
    const wait = input.declared?.wait;
    const finished = input.declared?.finished === true;
    const request = input.declared?.needsFirstmate;
    const result = input.declared?.result;
    const declaredBack = input.declared?.checkBack;
    const checkBack = declaredBack
      ? { at, until: at + declaredBack.minutes * 60_000, waitingFor: declaredBack.waitingFor }
      : undefined;
    const run = this.write(() => {
      const record = this.mustGet(id);
      const completion = input.declared?.mergeCompletesTask;
      const declaring =
        Boolean(wait) || finished || Boolean(request) || Boolean(checkBack) || Boolean(completion);
      // The result rides the report's event alone (INF-1296 piece 1): the
      // latest one stands until a later report carries another.
      const delivery =
        declaring || hasDeclaration(record)
          ? this.mergeDelivery(record, {
              captainWait: wait ? { at, ...wait } : undefined,
              finishedAt: finished ? at : undefined,
              mergeCompletion: completion ? { ...completion, at } : undefined,
              needsFirstmate: request ? { at, request } : undefined,
              checkBack,
            })
          : undefined;
      // A check-back is the task's timed wait (INF-1244): the sweep turns its
      // end into a steer. A captain gate already standing outranks it.
      const timed =
        checkBack && (!record.gate || record.gate.kind === "at-time")
          ? {
              gate: {
                kind: "at-time" as const,
                until: checkBack.until,
                reason: checkBack.waitingFor,
              },
            }
          : {};
      this.patch(id, {
        outcome: text,
        outcomeSummary: summary,
        ...(delivery ? { delivery } : {}),
        ...timed,
        updatedAt: at,
      });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "crewmate",
        kind: "report",
        text,
        data: {
          ...(summary ? { summary } : {}),
          ...(input.usage ? { usage: input.usage } : {}),
          ...(wait ? { waitingOnCaptain: wait } : {}),
          ...(finished ? { finished: true } : {}),
          ...(input.declared?.mergeCompletesTask
            ? { mergeCompletesTask: input.declared.mergeCompletesTask }
            : {}),
          ...(input.declared?.needsFirstmate
            ? { needsFirstmate: input.declared.needsFirstmate }
            : {}),
          ...(checkBack
            ? { checkBack: { until: checkBack.until, waitingFor: checkBack.waitingFor } }
            : {}),
          ...(result ? { result } : {}),
          ...(input.declared?.firstRelease ? { firstRelease: input.declared.firstRelease } : {}),
          ...(recovery.workWait ? { workWait: recovery.workWait } : {}),
          ...(recovery.recoveryWays ? { recoveryWays: recovery.recoveryWays } : {}),
        },
      });
    });
    run();
  }

  /**
   * A new turn started on the task: whatever its last report declared about
   * whose turn followed it no longer stands (FI3-435). Returns whether there
   * was a declaration to clear, so the caller re-reads the captain gate.
   */
  clearDeclaration(id: string): boolean {
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record || !hasDeclaration(record)) return false;
      this.patch(id, {
        delivery: this.mergeDelivery(record, {
          captainWait: undefined,
          finishedAt: undefined,
          mergeCompletion: undefined,
          needsFirstmate: undefined,
          checkBack: undefined,
        }),
        // A check-back's timed wait goes with it: the turn it waited for runs.
        ...(record.delivery?.checkBack && record.gate?.kind === "at-time" ? { gate: null } : {}),
        updatedAt: this.now(),
      });
      return true;
    });
    return run();
  }

  /**
   * A provider-failed turn on a task that stays alive and steerable. A
   * failure a typed backend reported keeps its class beside the words
   * (`typedFailureOf` reads it back), so nothing downstream reads the words
   * for it (docs/quota.md "Typed cut-offs").
   */
  recordTurnFailure(id: string, error: string, typed?: TypedFailure): void {
    const at = this.now();
    const run = this.write(() => {
      this.patch(id, { updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "failed",
        text: `hit a problem: ${error}`,
        data: {
          error,
          fatal: false,
          ...(typed ? { failureSignals: "typed" } : {}),
          ...(typed?.cutOff ? { cutOff: typed.cutOff } : {}),
        },
      });
    });
    run();
  }

  /**
   * A steer the crew control plane accepted - delivered into the turn,
   * queued for the next one, recorded for retry, or queued behind a
   * supervision claim (R2 forward capture: this is how a direct steer
   * becomes observable). The message is redacted at capture. Returns the
   * event id, which the issuing decision lists in its `controls`.
   */
  recordSteer(
    id: string,
    input: { text: string; actor: TaskEventActor } & SteerEventData,
  ): number | undefined {
    const at = this.now();
    const run = this.write((): number | undefined => {
      if (!this.store.get(id)) return undefined;
      this.patch(id, { updatedAt: at });
      const text = redactObserveText(input.text);
      const data: SteerEventData = {
        outcome: input.outcome,
        via: input.via,
        decision: input.decision,
        cardId: input.cardId,
        inboxId: input.inboxId,
        ...(input.panel ? { panel: input.panel } : {}),
        // The span stands only on the text it was measured on.
        ...(input.words && text === input.text ? { words: input.words } : {}),
      };
      return this.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "steered",
        text,
        data,
        ...(input.decision ? { ref: input.decision } : {}),
        feed: false,
      });
    });
    return run();
  }

  /**
   * An interrupt or cancel request, with what it did at that moment (R2
   * forward capture). Written before any close it causes, so the timeline
   * reads request then effect.
   */
  recordInterrupt(
    id: string,
    input: { actor: TaskEventActor } & Omit<InterruptEventData, "error"> & {
        error?: string | null;
      },
  ): number | undefined {
    const at = this.now();
    const run = this.write((): number | undefined => {
      if (!this.store.get(id)) return undefined;
      this.patch(id, { updatedAt: at });
      const data: InterruptEventData = {
        mode: input.mode,
        effect: input.effect,
        error: input.error ? redactObserveText(input.error) : null,
        via: input.via,
        decision: input.decision,
        ...(input.panel ? { panel: input.panel } : {}),
      };
      return this.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "interrupted",
        text: input.mode === "cancel" ? "cancel requested" : "interrupt requested",
        data,
        ...(input.decision ? { ref: input.decision } : {}),
        feed: false,
      });
    });
    return run();
  }

  /**
   * A policy-step decision ended (R2 prospective provenance): one `decided`
   * event on every task it was about, all carrying the same record with the
   * decision id as `ref`. Machinery, never a task change - no `updated_at`,
   * never on the feed or the record pane. A decision about no task writes
   * nothing here; its served input is still self-describing in the session.
   * Structured capture for taskless operational wakes is deferred to the
   * supervision-coverage board outcome rather than inventing an anchor.
   */
  recordDecision(record: DecisionRecord): number[] {
    const run = this.write((): number[] => {
      const ids: number[] = [];
      for (const taskId of record.disposition.tasks) {
        if (!this.store.get(taskId)) continue;
        ids.push(
          this.addEvent({
            taskId,
            at: record.endedAt,
            actor: record.producer.actor,
            kind: "decided",
            text: `decision ${record.decision}: ${record.disposition.outcome}`,
            data: record as unknown as Record<string, unknown>,
            ref: record.decision,
            feed: false,
          }),
        );
      }
      return ids;
    });
    return run();
  }

  /**
   * A host or watchdog line on the timeline (quiet notices, dispatch
   * failures). Its writer declares what it is: `news` is a row of the
   * record's Activity, anything else bookkeeping, folded under the row it
   * led to (docs/task-record.md, "What Activity holds").
   */
  note(
    id: string,
    text: string,
    options: {
      news: boolean;
      actor?: TaskEventActor;
      feed?: boolean;
      data?: Record<string, unknown>;
      /**
       * Other tasks the note names, such as the blockers a refused merge
       * waits on: each it is linked to reads it too (`concernsOf`).
       */
      about?: readonly string[];
    },
  ): void {
    const at = this.now();
    const run = this.write(() => {
      this.patch(id, { updatedAt: at });
      this.addEvent(
        {
          taskId: id,
          at,
          actor: options.actor ?? "host",
          kind: "note",
          text,
          data: { ...options.data, news: options.news },
          feed: options.feed ?? false,
        },
        options.about,
      );
    });
    run();
  }

  /**
   * A reply in the thread of one of the task's cards, by its crewmate or by
   * Firstmate (docs/card-threads.md): a row on the task's Activity, as the
   * captain's own reply is through its steer. The words are the author's;
   * the captain's are never copied here.
   */
  recordReply(
    id: string,
    input: { cardId: string; title: string; text: string; actor: "crewmate" | "firstmate" },
  ): void {
    const at = this.now();
    const run = this.write(() => {
      if (!this.store.get(id)) return;
      this.patch(id, { updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "replied",
        text: redactObserveText(input.text),
        data: { cardId: input.cardId, title: input.title },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }

  /**
   * The escalation pair (intelligence-bucket routing S4, report section 4
   * step 6). One act, two timeline rows written together: the rejected
   * attempt records that it was escalated and names its successor - the
   * ONE feed line the whole move gets - and the fresh attempt opens with
   * where it came from. Neither row is a card and nothing else surfaces:
   * the now panel simply shows the new row underway and the old one gone.
   */
  recordEscalation(input: {
    from: { id: string; key: string };
    to: { id: string; key: string };
    attempt: number;
    tier: IntelligenceBucket;
  }): void {
    const at = this.now();
    const run = this.write(() => {
      this.mustGet(input.from.id);
      this.mustGet(input.to.id);
      this.addEvent({
        taskId: input.from.id,
        at,
        actor: "captain",
        kind: "escalated",
        text: `moved to a stronger model (${input.tier}) after the captain's review - continues as ${input.to.key}`,
        data: { escalated_to: input.to.key, attempt: input.attempt, tier: input.tier },
        ref: input.to.id,
        feed: true,
      });
      this.addEvent({
        taskId: input.to.id,
        at,
        actor: "captain",
        kind: "escalated",
        text: `attempt ${input.attempt} with a stronger model (${input.tier}), after ${input.from.key}`,
        data: { escalated_from: input.from.key, attempt: input.attempt, tier: input.tier },
        ref: input.from.id,
        feed: false,
      });
    });
    run();
  }

  recordLiveValidation(
    id: string,
    input: KeptValidationInput,
    context: Omit<Parameters<typeof recordValidation>[2], "at" | "deviceId">,
  ): void {
    this.write(() => {
      const task = this.mustGet(id);
      const liveValidation = recordValidation(task.delivery?.liveValidation, input, {
        ...context,
        at: this.now(),
        deviceId: task.deviceId ?? null,
      });
      this.writeDeliveryRecords(
        id,
        { liveValidation },
        {
          kind: "note",
          text: `Live validation: ${input.kind}`,
          feed: false,
          data: {
            validation: {
              kind: input.kind,
              scenarioRevision: liveValidation.scenarioRevision,
              stateRevision: liveValidation.stateRevision ?? 0,
              ...("head" in input ? { head: input.head } : {}),
              ...(input.kind === "run"
                ? {
                    run: input.id,
                    revision: liveValidation.runs.at(-1)?.revision,
                    evidence: input.evidence.map(({ id, digest, file, bytes }) => ({
                      id,
                      digest,
                      file,
                      bytes,
                    })),
                  }
                : {}),
              ...(input.kind === "request" ? { request: input.request.id } : {}),
            },
          },
        },
      );
    })();
  }

  expireValidationDecision(id: string, card: string, offer: string, reason: string): void {
    this.write(() => {
      const task = this.mustGet(id);
      if (!task.delivery?.liveValidation) return;
      const liveValidation = structuredClone(task.delivery.liveValidation);
      for (const item of liveValidation.permissions) {
        if (
          item.state !== "requested" ||
          item.decision?.card !== card ||
          item.decision.offer !== offer
        )
          continue;
        item.state = "expired";
        liveValidation.stateRevision = (liveValidation.stateRevision ?? 0) + 1;
      }
      this.writeDeliveryRecords(
        id,
        { liveValidation },
        { kind: "note", text: reason, data: { validationDecisionExpired: { card, offer } } },
      );
    })();
  }

  decideLiveValidation(
    id: string,
    input: Omit<Parameters<typeof decideValidation>[1], "at">,
  ): void {
    this.write(() => {
      const task = this.mustGet(id);
      if (!task.delivery?.liveValidation) return;
      const liveValidation = decideValidation(task.delivery.liveValidation, {
        ...input,
        at: this.now(),
      });
      this.writeDeliveryRecords(
        id,
        { liveValidation },
        {
          kind: "note",
          text: "The captain answered a live-validation request",
          feed: false,
          data: { validationDecision: input },
        },
      );
    })();
  }

  /**
   * Delivery facts as they become known: a CI read, an opened PR. The mode
   * comes from the repo posture when the row has none yet.
   */
  recordChangeEvidence(id: string, facts: ChangeEvidenceUpdate, event?: DeliveryObservation): void {
    const elsewhere = [
      ...Object.keys(PERMISSION_COLUMNS),
      ...TURN_DECLARATION_FIELDS,
      ...HISTORY_FIELDS,
      "liveValidation",
    ];
    if (elsewhere.some((field) => Object.hasOwn(facts, field)))
      throw new Error("Change evidence cannot write permissions, turn declarations or history.");
    this.writeDeliveryRecords(id, facts, event);
  }

  /** The permission owner's typed records; no evidence or execution patch can travel with them. */
  recordPermissionRecords(
    id: string,
    records: Partial<Pick<TaskDelivery, PermissionField>>,
    event?: DeliveryObservation,
  ): void {
    if (Object.keys(records).some((field) => !Object.hasOwn(PERMISSION_COLUMNS, field)))
      throw new Error("A permission write can only replace permission records.");
    this.writeDeliveryRecords(id, records, event);
  }

  /** Bind the reading to the exact approval and version in the same transaction. */
  recordApprovedChangeReading(
    id: string,
    reading: Pick<TaskDelivery, "mergeAuthorization" | "versionReadings">,
  ): void {
    this.writeDeliveryRecords(id, reading);
  }

  /** A resolved wait ends in execution, never in a historical report. */
  clearCaptainWait(id: string): void {
    this.writeDeliveryRecords(id, { captainWait: undefined });
  }

  private writeDeliveryRecords(
    id: string,
    patch: Partial<TaskDelivery>,
    event?: DeliveryObservation,
  ): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.mustGet(id);
      const delivery = this.mergeDelivery(record, patch);
      this.patch(id, { delivery, updatedAt: at });
      if (event) {
        const { liveValidation: _validationState, ...eventPatch } = patch;
        this.addEvent({
          taskId: id,
          at,
          actor: event.actor ?? "host",
          kind: event.kind,
          text: event.text,
          data: { ...eventPatch, ...event.data },
          feed: event.feed ?? false,
        });
      }
    });
    run();
  }

  /** The publication ledger's one writer; a claim is committed before any external write. */
  changePresentation(id: string): ChangePresentationRecord | undefined {
    return this.mustGet(id).delivery?.presentation;
  }

  updateChangePresentation(
    id: string,
    update: (current: ChangePresentationRecord | undefined) => ChangePresentationRecord,
  ): void {
    this.write(() => {
      const record = this.mustGet(id);
      if (record.status === "done" || record.status === "dropped")
        throw new Error("A closed task cannot publish another story.");
      const presentation = update(record.delivery?.presentation);
      this.patch(id, {
        delivery: this.mergeDelivery(record, { presentation }),
        updatedAt: this.now(),
      });
    })();
  }

  /**
   * Keep a write the crewmate asked to send (FI3-1571 piece 4), newest
   * first, at most `WRITE_ASK_CAP`: an older one drops, sent or not. A
   * closed task keeps none.
   */
  keepWriteAsk(id: string, ask: WriteAsk): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.mustGet(id);
      if (TaskService.isClosed(record)) {
        throw new TaskGraphRefusal(`Refused: ${record.key || record.id} is closed.`);
      }
      const writeAsks = [
        ask,
        ...(record.delivery?.writeAsks ?? []).filter((kept) => kept.id !== ask.id),
      ].slice(0, WRITE_ASK_CAP);
      this.patch(id, { delivery: this.mergeDelivery(record, { writeAsks }), updatedAt: at });
    });
    run();
  }

  /**
   * The captain's click takes one kept write, once (FI3-1571 piece 4): in one
   * transaction it checks the task is open and the ask was never taken, and
   * marks it taken before anything is sent, so a second click, a restart or
   * a revised card never sends it again. The refusal says why, in the
   * host's words.
   */
  takeWriteAsk(id: string, askId: string): { ask: WriteAsk } | { refused: string } {
    const at = this.now();
    let result: { ask: WriteAsk } | { refused: string } = { refused: "" };
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record || TaskService.isClosed(record)) {
        result = { refused: "its task has closed, so it was not sent." };
        return;
      }
      const asks = record.delivery?.writeAsks ?? [];
      const ask = asks.find((kept) => kept.id === askId);
      if (!ask) {
        result = { refused: `ask ${askId} is not on this task, so nothing was sent.` };
        return;
      }
      if (ask.sentAt !== undefined) {
        result = { refused: `ask ${askId} was already sent once and is ${NEVER_SENT_AGAIN}.` };
        return;
      }
      const taken = { ...ask, sentAt: at };
      this.patch(id, {
        delivery: this.mergeDelivery(record, {
          writeAsks: asks.map((kept) => (kept.id === askId ? taken : kept)),
        }),
        updatedAt: at,
      });
      result = { ask: taken };
    });
    run();
    return result;
  }

  /** What came of a taken write: the host's answer, unknown, or nothing sent. */
  recordWriteAskOutcome(id: string, askId: string, outcome: WriteAskOutcome): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.store.get(id);
      const asks = record?.delivery?.writeAsks;
      if (!record || !asks?.some((kept) => kept.id === askId)) return;
      this.patch(id, {
        delivery: this.mergeDelivery(record, {
          writeAsks: asks.map((kept) => (kept.id === askId ? { ...kept, outcome } : kept)),
        }),
        updatedAt: at,
      });
    });
    run();
  }

  /**
   * The host refused this task's completion card (FI3-401): the refusal
   * stands on the delivery facts until a completion card goes up, and the
   * timeline keeps it as a host note.
   */
  recordCardRefusal(id: string, refusal: Omit<CardRefusal, "at">): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.mustGet(id);
      const cardRefusal: CardRefusal = { at, ...refusal };
      this.patch(id, { delivery: this.mergeDelivery(record, { cardRefusal }), updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "note",
        text: `completion card "${refusal.title}" refused: ${refusal.why}`,
        data: { cardRefusal, news: false },
        feed: false,
      });
    });
    run();
  }

  /** A completion card went up: the refusal before it no longer stands. */
  clearCardRefusal(id: string): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.store.get(id);
      if (!record?.delivery?.cardRefusal) return;
      const { cardRefusal: _cleared, ...delivery } = record.delivery;
      this.patch(id, { delivery, updatedAt: at });
    });
    run();
  }

  /** Persist or clear a settle intent captured while a crewmate turn is active. */
  setPendingSettle(id: string, intent: PendingSettleIntent | null): void {
    const at = this.now();
    const run = this.write(() => {
      this.mustGet(id);
      this.patch(id, { pendingSettle: intent, updatedAt: at });
    });
    run();
  }

  /**
   * Close the record: done (landed, merged, released, answered, settled) or dropped
   * (cancelled, discarded, failed, superseded). An idle crewmate with
   * unlanded work is not a close - it stays `active` and resumable until
   * merged, landed or discarded (WI-11). Never a delete - the row, its
   * timeline and its session JSONL survive (D2).
   */
  close(id: string, input: CloseInput): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.mustGet(id);
      const action = record.delivery?.captainAction;
      if (
        action &&
        input.status === "done" &&
        action.state !== "confirmed" &&
        action.state !== "checked"
      )
        throw new TaskGraphRefusal(
          "This required action needs your confirmation on its card or a supported Infinitary check.",
        );
      const closedPolicies = this.policiesOf(record);
      // A closed task's writes that were never sent can no longer be (FI3-1571):
      // only the ones its captain's click took stay, as the record of it.
      const asks = record.delivery?.writeAsks;
      const unsent = asks?.some((ask) => ask.sentAt === undefined) ?? false;
      // Closing a record must never manufacture routing provenance. Keep
      // the snapshot with the closed outcome, preserving published facts.
      const delivery =
        input.delivery || closedPolicies || unsent
          ? this.mergeDelivery(record, {
              ...input.delivery,
              ...(closedPolicies ? { closedPolicies } : {}),
              ...(unsent ? { writeAsks: asks?.filter((ask) => ask.sentAt !== undefined) } : {}),
            })
          : record.delivery;
      if (input.status === "dropped" && delivery?.captainAction) {
        delivery.captainAction = {
          ...delivery.captainAction,
          state: "cancelled",
          completedAt: at,
          cancelledReason: input.text ?? input.reason,
        };
      }
      if (record.placement && !record.placement.preparationStarted)
        this.releasePlacement(id, record.placement.snapshot.orderId, "ended");
      this.patch(id, {
        status: input.status,
        activity: null,
        closedReason: input.reason,
        closedAt: at,
        gate: null,
        delivery,
        pendingSettle: null,
        updatedAt: at,
      });
      if (input.reason === "merged" || input.reason === "landed") this.activateRequiredActions(id);
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: CLOSE_EVENT_KIND[input.reason],
        text: input.text ?? defaultCloseText(input),
        data: {
          status: input.status,
          reason: input.reason,
          ...(input.error ? { error: input.error } : {}),
          ...(input.data ?? {}),
        },
        ...(input.feed === false ? { feed: false } : {}),
      });
    });
    run();
  }

  validateRequiredActions(sourceId: string, actions: readonly RequiredAction[]): RequiredAction[] {
    const ids = new Set<string>();
    return actions.map((action) => {
      if (ids.has(action.id))
        throw new TaskGraphRefusal(`Required action ${action.id} is declared twice.`);
      ids.add(action.id);
      const prerequisites = action.prerequisites.map((ref) => {
        const row = this.resolve(ref);
        if (!row || row.id === sourceId)
          throw new TaskGraphRefusal(
            `Required action prerequisite ${ref} must name another existing task.`,
          );
        return row.id;
      });
      const shared = this.listOpen().find((row) =>
        row.delivery?.captainAction?.requirements.some(
          (entry) =>
            (entry.source === sourceId && entry.action.id === action.id) ||
            (action.sharedId && entry.action.sharedId === action.sharedId),
        ),
      );
      if (
        shared &&
        prerequisites.some(
          (prerequisite) =>
            prerequisite === shared.id || this.blocksReaches(shared.id, prerequisite),
        )
      )
        throw new TaskGraphRefusal("The required action's prerequisites would form a cycle.");
      const incompatible = (other: RequiredAction) =>
        other.target !== action.target ||
        other.completion.kind !== action.completion.kind ||
        (other.completion.kind === "device-version" &&
          action.completion.kind === "device-version" &&
          other.completion.deviceId !== action.completion.deviceId);
      if (
        (action.sharedId &&
          actions.some(
            (other) =>
              other.id !== action.id && other.sharedId === action.sharedId && incompatible(other),
          )) ||
        shared?.delivery?.captainAction?.requirements.some(
          (entry) =>
            (entry.source !== sourceId || entry.action.id !== action.id) &&
            incompatible(entry.action),
        )
      )
        throw new TaskGraphRefusal(
          "A shared action must keep the same target and completion mode. Declare separate actions instead.",
        );
      return { ...action, prerequisites };
    });
  }

  /** The declaration and source version are kept before the merge, never inferred from prose. */
  declareRequiredActions(id: string, offer: RequiredActionOffer, immediate = false): void {
    this.write(() => {
      const actions = this.validateRequiredActions(id, offer.actions);
      this.writeDeliveryRecords(id, { requiredActionOffer: { ...offer, actions } });
      if (immediate) this.activateRequiredActions(id);
    })();
  }

  /** Called inside successful close's transaction; receipts make restart/retry recovery idempotent. */
  activateRequiredActions(sourceId: string): void {
    const source = this.mustGet(sourceId);
    const offer = source.delivery?.requiredActionOffer;
    if (!offer) return; // Historical offers are unknown, not an empty declaration.
    for (const action of offer.actions) {
      const receipt = `${sourceId}:${offer.offerId}:${action.id}`;
      const existing = this.list().find((row) =>
        row.delivery?.captainAction?.requirements.some(
          (requirement) =>
            `${requirement.source}:${requirement.offer}:${requirement.action.id}` === receipt,
        ),
      );
      if (existing) continue;
      const outstanding = this.listOpen().find((row) =>
        row.delivery?.captainAction?.requirements.some(
          (requirement) => requirement.source === sourceId && requirement.action.id === action.id,
        ),
      );
      const shared =
        outstanding ??
        (action.sharedId
          ? this.list().find((row) => {
              const state = row.delivery?.captainAction;
              return (
                row.status === "open" &&
                state &&
                state.requirements.some(
                  (requirement) => requirement.action.sharedId === action.sharedId,
                )
              );
            })
          : undefined);
      const id = shared?.id ?? randomUUID().slice(0, 8);
      if (!shared)
        this.create({
          id,
          kind: "operation",
          title: action.title.slice(0, 64),
          goal: action.criterion,
          prompt: "",
          repoId: null,
          projectId: source.projectId,
          actor: "host",
          startPolicy: "on-request",
          gate: { kind: "captain", ref: `card-fm-required-action-${id}` },
        });
      const prior = shared?.delivery?.captainAction;
      const previous = prior?.requirements.find(
        (requirement) => requirement.source === sourceId && requirement.action.id === action.id,
      );
      const changed =
        !previous ||
        previous.head !== offer.head ||
        JSON.stringify(previous.action) !== JSON.stringify(action);
      const state: CaptainAction = {
        requirements: [
          ...(prior?.requirements ?? []).filter(
            (requirement) =>
              !(requirement.source === sourceId && requirement.action.id === action.id),
          ),
          {
            source: sourceId,
            offer: offer.offerId,
            ...(offer.head ? { head: offer.head } : {}),
            action,
          },
        ],
        generation: (prior?.generation ?? 0) + (changed ? 1 : 0),
        state: changed ? "blocked" : (prior?.state ?? "blocked"),
        cardId: `card-fm-required-action-${id}`,
        presentedGeneration: prior?.presentedGeneration ?? 0,
        activatedAt: prior?.activatedAt ?? this.now(),
      };
      this.writeDeliveryRecords(id, { captainAction: state });
      const first = state.requirements[0]?.action;
      if (first)
        this.patch(id, {
          title: first.title.slice(0, 64),
          goal: first.criterion,
          updatedAt: this.now(),
        });
      const needed = new Set(state.requirements.flatMap((entry) => entry.action.prerequisites));
      for (const blocker of this.blockers(id))
        if (!needed.has(blocker.id)) this.unlink(blocker.id, id, "blocks", "host");
      this.insertLink(sourceId, id, "related", "host", this.now());
      for (const prerequisite of action.prerequisites) {
        if (!this.get(prerequisite))
          throw new Error(`Required action prerequisite ${prerequisite} does not exist.`);
        this.insertLink(prerequisite, id, "blocks", "host", this.now(), true);
      }
      this.addEvent({
        taskId: id,
        at: this.now(),
        actor: "host",
        kind: "note",
        text: `Required action from ${source.key}: ${action.title}`,
        data: { source: sourceId, offer: offer.offerId },
        feed: false,
      });
    }
  }

  captainActionReady(id: string): boolean {
    const row = this.get(id);
    return (
      row?.status === "open" &&
      Boolean(row.delivery?.captainAction) &&
      this.blockers(id).every((blocker) => blocker.status === "done")
    );
  }

  presentCaptainAction(id: string): CaptainAction | undefined {
    const action = this.get(id)?.delivery?.captainAction;
    if (!action || !this.captainActionReady(id)) return undefined;
    const next: CaptainAction = {
      ...action,
      state: "ready",
      presentedGeneration: action.generation,
    };
    this.writeDeliveryRecords(id, { captainAction: next });
    return next;
  }

  deferCaptainAction(id: string): void {
    const action = this.get(id)?.delivery?.captainAction;
    if (!action || this.get(id)?.status !== "open") return;
    this.writeDeliveryRecords(id, { captainAction: { ...action, state: "deferred" } });
  }

  /** Only the host's human button or a fresh typed observation can finish this operation. */
  completeCaptainAction(id: string, generation: number, mode: "confirmed" | "checked"): boolean {
    return this.write(() => {
      const action = this.get(id)?.delivery?.captainAction;
      if (!action || !this.captainActionReady(id) || action.generation !== generation) return false;
      if (
        mode === "confirmed" &&
        (action.presentedGeneration !== generation ||
          action.requirements.some(
            (requirement) => requirement.action.completion.kind !== "manual",
          ))
      )
        return false;
      if (
        mode === "checked" &&
        action.requirements.some(
          (requirement) => requirement.action.completion.kind !== "device-version",
        )
      )
        return false;
      const next: CaptainAction = { ...action, state: mode, completedAt: this.now() };
      this.writeDeliveryRecords(id, { captainAction: next });
      this.close(id, {
        status: "done",
        reason: "answered",
        actor: mode === "confirmed" ? "captain" : "host",
        text: captainActionResult(next),
        data: { generation, requirements: action.requirements },
      });
      return true;
    })();
  }

  /** The worktree is gone; the record and its session stay (D2). */
  markWorkspaceRemoved(id: string): void {
    const at = this.now();
    const run = this.write(() => {
      const placement = this.mustGet(id).placement;
      if (placement) this.releasePlacement(id, placement.snapshot.orderId, "ended");
      this.patch(id, { workspaceState: "removed", updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "note",
        text: "working copy removed",
        data: { news: false },
        feed: false,
      });
    });
    run();
  }

  /**
   * A typed edge; `blocks` carries readiness. `holdsMerge` is the close
   * mark, and only a caller that promised the hold passes it. Idempotent;
   * a repeat that promises the hold sets the mark and never clears one.
   */
  link(
    fromId: string,
    toId: string,
    type: TaskLinkType,
    actor: TaskEventActor,
    holdsMerge = false,
  ): boolean {
    const at = this.now();
    const run = this.write(() => this.insertLink(fromId, toId, type, actor, at, holdsMerge));
    return run();
  }

  /**
   * The waits a crewmate's report names (INF-1428): one `blocks` link from
   * each task to the waiting one, a recorded wait that holds no merge, all
   * in one write - a cycle any of them would close refuses them all.
   * Returns the tasks newly linked.
   */
  linkWaits(waiterId: string, blockerIds: readonly string[], actor: TaskEventActor): string[] {
    const at = this.now();
    const run = this.write(() =>
      blockerIds.filter((fromId) => this.insertLink(fromId, waiterId, "blocks", actor, at)),
    );
    return run();
  }

  unlink(fromId: string, toId: string, type: TaskLinkType, actor: TaskEventActor): boolean {
    const at = this.now();
    const run = this.write(() => {
      const edgeRemoved = this.links.delete(fromId, toId, type);
      // INF-1137: baseline waits live on the delivery record, not in links.
      // Remove the standing reference too, keeping the diagnosis and failed
      // readings intact. One removal clears both representations of a wait.
      const record = this.mustGet(toId);
      const repair = record.delivery?.ciRepair;
      let baselineRemoved = false;
      if (type === "blocks" && repair) {
        const diagnoses = repair.diagnoses.map((diagnosis) => {
          if (
            diagnosis.classification !== "baseline-blocked" ||
            diagnosis.dependencyTask !== fromId ||
            !baselineStands(record.delivery, diagnosis)
          )
            return diagnosis;
          baselineRemoved = true;
          const { dependencyTask: _dependency, ...kept } = diagnosis;
          return kept;
        });
        if (baselineRemoved)
          this.writeDeliveryRecords(toId, { ciRepair: { ...repair, diagnoses } });
      }
      const removed = edgeRemoved || baselineRemoved;
      if (edgeRemoved && type === "blocks" && record.status === "open") {
        const shape = record.shape ?? { kind: "unclear" as const };
        this.patch(toId, {
          shape: {
            ...shape,
            start_wait_since: {
              ...shape.start_wait_since,
              dependencies: at,
            },
          },
          updatedAt: at,
        });
      }
      if (removed) {
        this.touch(fromId);
        const from = this.store.get(fromId);
        this.addEvent({
          taskId: toId,
          at,
          actor,
          kind: "unlinked",
          text: `no longer ${LINK_WORDS[type]} "${from?.title ?? fromId}"`,
          data: { fromId, type },
          ref: fromId,
          feed: false,
        });
      }
      return removed;
    });
    return run();
  }

  /**
   * A previous process claimed a row and died before `dispatch` wrote a
   * worktree. Put those rows back on the ready query (no captain gate) so
   * the next sweep retries instead of leaving them interrupted and stuck.
   */
  private releaseUnstartedDispatches(): void {
    // A task on a computer that runs work has no working copy here; its start
    // finished once its conversation there was recorded. So did a task that
    // builds in place (the personal workspace has no worktree): it is back on
    // the queue only when no conversation was ever recorded for it.
    const orphans = this.store
      .listByStatus("active")
      .filter(
        (record) =>
          record.kind === "work" &&
          (record.deviceId ? !record.sessionFile : !record.worktreeDir && !record.sessionFile),
      );
    if (orphans.length === 0) return;
    const run = this.write(() => {
      const at = this.now();
      for (const record of orphans) {
        this.patch(record.id, {
          status: "open",
          activity: null,
          gate: null,
          assignee: null,
          model: null,
          updatedAt: at,
        });
        this.addEvent({
          taskId: record.id,
          at,
          actor: "host",
          kind: "status",
          text: "returned to the queue - the start did not finish",
        });
      }
    });
    run();
  }

  /** A spawn that failed before its crewmate ever ran leaves nothing behind. */
  discardFailedSpawn(id: string): void {
    this.erase(id);
  }

  /**
   * A settled run's later step (docs/orchestrator-contract.md, "Settled
   * runs"): the run's one operation, in its place, says where the setting
   * stands now.
   */
  reviseOperation(id: string, input: { title: string; outcome: string }): void {
    const at = this.now();
    const run = this.write(() => {
      const record = this.mustGet(id);
      if (record.kind !== "operation") throw new Error(`${record.key} is not an operation.`);
      this.patch(id, {
        title: input.title,
        outcome: input.outcome,
        outcomeSummary: reportSummary(input.outcome) || null,
        closedAt: at,
        updatedAt: at,
      });
    });
    run();
  }

  /** A settled run that came back where it started leaves no operation. */
  withdrawOperation(id: string): void {
    const record = this.mustGet(id);
    if (record.kind !== "operation") throw new Error(`${record.key} is not an operation.`);
    this.erase(id);
  }

  /** A row, its timeline and its links, gone as if never written. */
  private erase(id: string): void {
    const run = this.write(() => {
      this.db
        .prepare(
          "DELETE FROM task_event_concerns WHERE task_id = ? OR event_id IN (SELECT id FROM task_events WHERE task_id = ?)",
        )
        .run(id, id);
      this.db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM task_links WHERE from_id = ? OR to_id = ?").run(id, id);
      this.db.prepare("DELETE FROM task_sessions WHERE task_id = ?").run(id);
      this.references.deleteFor(id);
      this.store.delete(id);
      this.pending.removed.add(id);
    });
    run();
  }

  /** The D-13 purge: every task, event, link and ask; projects stay. */
  purge(): number {
    const run = this.write(() => {
      this.events.deleteAll();
      this.links.deleteAll();
      this.asks.deleteAll();
      this.db.prepare("DELETE FROM task_sessions").run();
      this.references.deleteAll();
      this.pending.reset = true;
      return this.store.deleteAll();
    });
    return run();
  }

  /**
   * Reload an export (P5, `src/core/tasks/taskExport.ts`): every row
   * verbatim, in one transaction, through the one writer. Refused before
   * anything is written when a task id or key is already taken, when a
   * project key belongs to another id, or when a row references a task
   * that is neither in the bundle nor here. A project already present keeps
   * its row and only its sequence rises; a missing one is inserted as
   * exported. The board resets, so clients take a fresh snapshot.
   */
  importRecords(bundle: TaskExportBundle): {
    projects: number;
    tasks: number;
    events: number;
    links: number;
    asks: number;
  } {
    const run = this.write(() => {
      const known = new Set(this.store.list().map((record) => record.id));
      const incoming = new Set(bundle.tasks.map((record) => record.id));
      const refuse = (why: string): never => {
        throw new Error(`Import refused: ${why}`);
      };
      const resolves = (id: string | null): boolean =>
        id === null || incoming.has(id) || known.has(id);
      for (const project of bundle.projects) {
        const byId = this.projects.get(project.id);
        const byKey = this.projects.byKey(project.key);
        if (byKey && byKey.id !== project.id) {
          refuse(`project key ${project.key} belongs to "${byKey.id}", not "${project.id}".`);
        }
        if (byId && byId.key !== project.key) {
          refuse(`project "${project.id}" is keyed ${byId.key} here, not ${project.key}.`);
        }
      }
      const projectIds = new Set([
        ...bundle.projects.map((project) => project.id),
        ...this.projects.list().map((project) => project.id),
      ]);
      for (const record of bundle.tasks) {
        if (known.has(record.id)) refuse(`task "${record.id}" already exists.`);
        if (this.store.byKey(record.key)) refuse(`task key ${record.key} is already taken.`);
        if (!projectIds.has(record.projectId)) {
          refuse(`task ${record.key} names an unknown project "${record.projectId}".`);
        }
        if (!resolves(record.parentId)) {
          refuse(`task ${record.key} names an unknown parent "${record.parentId}".`);
        }
      }
      for (const event of bundle.events) {
        if (!resolves(event.taskId)) refuse(`an event names an unknown task "${event.taskId}".`);
        for (const concern of event.concerns ?? []) {
          if (!resolves(concern.taskId)) {
            refuse(`an event concerns an unknown task "${concern.taskId}".`);
          }
        }
      }
      for (const link of bundle.links) {
        if (!resolves(link.fromId) || !resolves(link.toId)) {
          refuse(`a link names an unknown task ("${link.fromId}" -> "${link.toId}").`);
        }
      }
      for (const ask of bundle.asks) {
        if (this.asks.get(ask.id)) refuse(`ask "${ask.id}" already exists.`);
        if (!resolves(ask.taskId)) refuse(`ask "${ask.id}" names an unknown task "${ask.taskId}".`);
      }
      let projects = 0;
      for (const project of bundle.projects) {
        if (this.projects.get(project.id)) {
          this.projects.adopt(project);
        } else {
          this.projects.insert(project);
          projects += 1;
        }
      }
      const recorded = new Map<string, TaskReference[]>();
      for (const { taskId, reference } of bundle.references ?? []) {
        if (!incoming.has(taskId))
          throw new Error(`A relationship names an unknown task: ${taskId}`);
        recorded.set(taskId, [...(recorded.get(taskId) ?? []), reference]);
      }
      const named: [TaskRecord, TaskReferenceKind, string][] = [];
      for (const record of bundle.tasks) {
        const { shape, named: inShape } = splitReferences(record.shape);
        this.store.insert({ ...record, shape });
        for (const [kind, ref] of inShape)
          if (!recorded.get(record.id)?.some((reference) => reference.kind === kind))
            named.push([record, kind, ref]);
        this.projects.raiseNextSeq(record.projectId, record.seq + 1);
        this.touch(record.id);
      }
      for (const { taskId, specifications } of bundle.specifications ?? []) {
        if (!incoming.has(taskId)) refuse(`A specification names an unknown task: ${taskId}`);
        this.store.specifications.restore(taskId, specifications);
      }
      // As exported: a recorded relationship keeps who recorded it and the
      // task it resolved to; a shape's name from an older export resolves
      // now, against this record, with who and when unknown.
      for (const [taskId, references] of recorded)
        for (const reference of references) this.references.set(taskId, reference);
      for (const [record, kind, ref] of named)
        this.references.set(record.id, {
          kind,
          ref,
          targetId: this.resolve(ref)?.id ?? null,
          actor: null,
          recordedAt: null,
        });
      for (const { taskId, session } of bundle.sessions ?? []) {
        if (!incoming.has(taskId)) throw new Error(`Session names an unknown task: ${taskId}`);
        this.conversations.record(taskId, session);
      }
      for (const { taskId, observation } of bundle.sessionObservations ?? []) {
        if (!incoming.has(taskId)) refuse(`A session observation names an unknown task: ${taskId}`);
        const { id, ...facts } = observation;
        this.conversations.observe(taskId, facts, id);
      }

      // A resume binding names its conversation once the conversations are in.
      const exported = new Map(
        (bundle.conversations ?? []).map(({ taskId, conversation }) => [taskId, conversation]),
      );
      for (const record of bundle.tasks)
        if (record.sessionFile)
          this.store.execution.pinConversation(record.id, exported.get(record.id));
      for (const { concerns, ...event } of bundle.events) {
        const id = this.events.insert(event);
        if (concerns?.length) this.events.insertConcerns(id, concerns);
      }
      for (const link of bundle.links) this.links.insert(link);
      for (const ask of bundle.asks) this.asks.insert(ask);
      this.pending.reset = true;
      return {
        projects,
        tasks: bundle.tasks.length,
        events: bundle.events.length,
        links: bundle.links.length,
        asks: bundle.asks.length,
      };
    });
    return run();
  }

  // ---- capture (P1) -------------------------------------------------------

  /** A captain turn begins: the ask row exists before the agent runs. */
  openAsk(input: OpenAskInput): AskRecord {
    const record: AskRecord = {
      id: input.id,
      at: input.at ?? this.now(),
      text: input.text,
      images: input.images ?? [],
      attachments: input.attachments ?? [],
      messageFiles: input.messageFiles ?? [],
      hintTaskId: input.hintTaskId ?? null,
      taskId: null,
      attachedVia: null,
      attachedAt: null,
      turnState: "open",
      delivery: "pending",
      deliveryFacts: { entries: [], ...(input.retryOf ? { retryOf: input.retryOf } : {}) },
      noticeCardId: null,
      followed: true,
      continues: null,
      answerCardId: null,
      acceptedAt: null,
      answeredAt: null,
      crewmateAskedAt: null,
    };
    this.asks.insert(record);
    return record;
  }

  /**
   * Attach an ask to a task: the first attachment fills the ask's columns,
   * every attachment writes an `ask` event on the task (one ask may be about
   * several tasks), in one transaction. Idempotent per (ask, task).
   */
  attachAsk(askId: string, taskId: string, via: AskAttachedVia): boolean {
    const at = this.now();
    const run = this.write((): boolean => {
      const ask = this.asks.get(askId);
      if (!ask) throw new Error(`Unknown ask "${askId}".`);
      this.mustGet(taskId);
      const already = this.events
        .listFor(taskId)
        .some((event) => event.kind === "ask" && event.ref === askId);
      if (already) return false;
      const first = this.asks.attach(askId, taskId, via, at);
      // A message about work an earlier message's work includes joins that
      // earlier message while it has not ended (docs/task-capture.md "How a
      // message ends").
      if (ask.followed && ask.continues === null) {
        const earlier = this.asksAbove(taskId).find(
          (other) =>
            other.id !== askId &&
            other.followed &&
            other.at <= ask.at &&
            other.answeredAt === null &&
            other.delivery !== "unresolved",
        );
        if (earlier) this.asks.setContinues(askId, earlier.continues ?? earlier.id);
      }
      this.patch(taskId, { updatedAt: at });
      this.addEvent({
        taskId,
        at,
        actor: "captain",
        kind: "ask",
        text: ask.text || (ask.images.length > 0 ? "(image attachment)" : "(empty)"),
        data: {
          askId,
          via,
          first,
          ...(ask.images.length > 0 ? { images: ask.images.length } : {}),
        },
        ref: askId,
        feed: false,
      });
      return true;
    });
    return run();
  }

  /**
   * Save one thing that took effect (or was refused) after Firstmate read
   * these messages (answer delivery). Only a message still being judged
   * takes it; a covered, unresolved or legacy one is left as it is.
   */
  noteDelivery(askIds: readonly string[], entry: DeliveryEntry): void {
    const run = this.write(() => {
      for (const id of askIds) {
        const ask = this.asks.get(id);
        if (!ask || !JUDGEABLE_DELIVERY.includes(ask.delivery)) continue;
        this.asks.setDelivery(id, ask.delivery, {
          ...ask.deliveryFacts,
          entries: [...ask.deliveryFacts.entries, entry],
        });
      }
    });
    run();
  }

  /** Move a message to a delivery state, keeping its facts unless new ones are given. */
  setAskDelivery(askId: string, delivery: AskDelivery, facts?: DeliveryFacts): void {
    const run = this.write(() => this.asks.setDelivery(askId, delivery, facts));
    run();
  }

  /** A message the turn never read: it waits for the turn that does, with no facts of this one. */
  releaseAskDelivery(askId: string): void {
    const run = this.write(() => {
      const ask = this.asks.get(askId);
      if (!ask || !JUDGEABLE_DELIVERY.includes(ask.delivery)) return;
      this.asks.setDelivery(askId, ask.delivery === "retrying" ? "retrying" : "pending", {
        ...ask.deliveryFacts,
        entries: [],
      });
    });
    run();
  }

  /** The one notice raised for a message: set once, in the same write that marks it unresolved. */
  markAskUnresolved(askId: string, cardId: string): boolean {
    const run = this.write((): boolean => {
      const ask = this.asks.get(askId);
      if (!ask || ask.delivery === "unresolved" || ask.noticeCardId) return false;
      this.asks.setDelivery(askId, "unresolved");
      this.asks.setNoticeCard(askId, cardId);
      return true;
    });
    return run();
  }

  /** The turn ended; the ask's state is final. */
  closeAsk(askId: string, turnState: Exclude<AskTurnState, "open">): AskRecord | undefined {
    const run = this.write(() => {
      this.asks.setTurnState(askId, turnState);
      const ask = this.asks.get(askId);
      // The ask rides the task's detail; its final state is a change there.
      if (ask?.taskId) this.touch(ask.taskId);
      return ask;
    });
    return run();
  }

  /** Join cross-service writes to the task change seam; publish only after commit. */
  atomic<T>(write: () => T, publish: (value: T) => void): T {
    if (this.depth > 0 || this.db.inTransaction) {
      throw new Error("An atomic publication must own the outer transaction.");
    }
    const value = this.write(write)();
    publish(value);
    return value;
  }

  /** A standalone question task, born closed with its answer (D1). */
  fileQuestion(input: FileQuestionInput): TaskRecord {
    const at = this.now();
    const actor = input.actor ?? "firstmate";
    const run = this.write((): TaskRecord => {
      this.create({
        id: input.id,
        kind: "question",
        title: input.title,
        prompt: "",
        repoId: input.repoId ?? null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        actor,
        createdAt: at,
      });
      const summary = input.outcome ? reportSummary(input.outcome) || null : null;
      this.patch(input.id, {
        outcome: input.outcome,
        outcomeSummary: summary,
        status: "done",
        activity: null,
        closedReason: "answered",
        closedAt: at,
        updatedAt: at,
      });
      if (input.cardId) {
        this.addEvent({
          taskId: input.id,
          at,
          actor,
          kind: "card_raised",
          text: `answered on card "${input.title}"`,
          data: { cardId: input.cardId, kind: "note" },
          ref: input.cardId,
          feed: false,
        });
      }
      this.addEvent({
        taskId: input.id,
        at,
        actor,
        kind: "status",
        text: input.fallback ? "noted (nothing attached this turn)" : "answered",
        data: {
          status: "done",
          reason: "answered",
          ...(input.fallback ? { fallback: input.fallback } : {}),
        },
        feed: false,
      });
      return this.mustGet(input.id);
    });
    return run();
  }

  /** A fleet/self operation the Firstmate performed, filed done/settled. */
  fileOperation(input: FileOperationInput): TaskRecord {
    const at = this.now();
    const actor = input.actor ?? "firstmate";
    const run = this.write((): TaskRecord => {
      this.create({
        id: input.id,
        kind: "operation",
        title: input.title,
        prompt: "",
        repoId: input.repoId ?? null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        actor,
        createdAt: at,
      });
      this.patch(input.id, {
        outcome: input.outcome,
        outcomeSummary: reportSummary(input.outcome) || null,
        status: "done",
        activity: null,
        closedReason: "settled",
        closedAt: at,
        updatedAt: at,
      });
      this.addEvent({
        taskId: input.id,
        at,
        actor,
        kind: "status",
        text: `settled by ${input.tool}`,
        data: { status: "done", reason: "settled", tool: input.tool },
        feed: false,
      });
      return this.mustGet(input.id);
    });
    return run();
  }

  /**
   * The row a host card with actions and no task files (docs/card-authoring.md,
   * "A card places the gate"): an open `operation` waiting on the captain,
   * its card id the gate ref, so "waiting on you" counts the host's own
   * asks the way it counts every other card. It closes with the card.
   */
  fileHostCardTask(input: { id: string; title: string; cardId: string }): TaskRecord {
    const at = this.now();
    const run = this.write((): TaskRecord => {
      this.create({
        id: input.id,
        kind: "operation",
        title: input.title,
        prompt: "",
        repoId: null,
        gate: { kind: "captain", ref: input.cardId },
        actor: "host",
        createdAt: at,
      });
      this.addEvent({
        taskId: input.id,
        at,
        actor: "host",
        kind: "card_raised",
        text: `decision raised on card "${input.title}"`,
        data: { cardId: input.cardId, kind: "decision" },
        ref: input.cardId,
        feed: false,
      });
      return this.mustGet(input.id);
    });
    return run();
  }

  /** An open decision task waiting on the captain; its card id is the gate ref. */
  fileDecision(input: FileDecisionInput): TaskRecord {
    const at = this.now();
    const actor = input.actor ?? "firstmate";
    const run = this.write((): TaskRecord => {
      this.create({
        id: input.id,
        kind: "decision",
        title: input.title,
        prompt: "",
        repoId: input.repoId ?? null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        gate: { kind: "captain", ref: input.cardId },
        actor,
        createdAt: at,
      });
      this.addEvent({
        taskId: input.id,
        at,
        actor,
        kind: "card_raised",
        text: `decision raised on card "${input.title}"`,
        data: { cardId: input.cardId, kind: "decision" },
        ref: input.cardId,
        feed: false,
      });
      return this.mustGet(input.id);
    });
    return run();
  }

  /** The task a card was raised on, if any (a revision keeps its row). */
  taskForCard(cardId: string): TaskRecord | undefined {
    const taskId = this.events.latestTaskForRef("card_raised", cardId);
    return taskId ? this.store.get(taskId) : undefined;
  }

  /**
   * A note card answered a question about this task: the body rides the
   * event. `asOutcome` also makes it the record's outcome (a standalone
   * question revised in place).
   */
  recordAnswer(
    id: string,
    input: {
      cardId: string;
      title: string;
      body: string;
      actor?: TaskEventActor;
      asOutcome?: boolean;
    },
  ): void {
    const at = this.now();
    const run = this.write(() => {
      this.mustGet(id);
      this.patch(id, {
        updatedAt: at,
        ...(input.asOutcome
          ? { outcome: input.body, outcomeSummary: reportSummary(input.body) || null }
          : {}),
      });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "firstmate",
        kind: "answered",
        text: input.title,
        data: { cardId: input.cardId, body: input.body },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }

  /**
   * A card about this task went on the stack. A crewmate's card is recorded
   * when it reaches the stage, with the close-out that released it
   * (`closeOut`), and again when it comes back with an answer to the
   * captain's reply (`returned`) - the moment the replay counts a late
   * return from (docs/card-threads.md "When a card reaches the stage").
   */
  recordCardRaised(
    id: string,
    input: {
      cardId: string;
      kind: string;
      title: string;
      actor?: TaskEventActor;
      closeOut?: string;
      returned?: boolean;
    },
  ): void {
    const at = this.now();
    const run = this.write(() => {
      if (!this.store.get(id)) return;
      this.patch(id, { updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "firstmate",
        kind: "card_raised",
        text: `${input.kind} card "${input.title}"${input.returned ? " back with its answer" : ""}`,
        data: {
          cardId: input.cardId,
          kind: input.kind,
          ...(input.closeOut ? { closeOut: input.closeOut } : {}),
          ...(input.returned ? { returned: true } : {}),
        },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }

  /** Verified delivery, not a verdict about whether the task is finished (INF-1426). */
  recordResultHandoff(
    id: string,
    handoff: { taskId: string } | { cardId: string; action: string },
  ): void {
    this.note(id, "Its result was handed on.", {
      news: false,
      feed: false,
      data: { resultHandoff: handoff, journal: true },
      ...("taskId" in handoff ? { about: [handoff.taskId] } : {}),
    });
  }

  resultHandoffOf(id: string): boolean {
    return this.events
      .listFor(id)
      .some((event) => event.kind === "note" && event.data?.resultHandoff !== undefined);
  }

  /** A card about this task left the stack (an action, Later, or a dismiss). */
  recordCardResolved(
    id: string,
    input: {
      cardId: string;
      title: string;
      action: string;
      actor?: TaskEventActor;
      /** The captain's answers to the body's own questions (contract 4.22). */
      answers?: CardAnswer[];
      /**
       * The card evidence's observation of the same choice or close: the
       * explicit alias the unified timeline folds this event into.
       */
      observation?: string;
    },
  ): void {
    const at = this.now();
    const run = this.write(() => {
      if (!this.store.get(id)) return;
      this.patch(id, { updatedAt: at });
      this.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "captain",
        kind: "card_resolved",
        text: `card "${input.title}": ${input.action}`,
        data: {
          cardId: input.cardId,
          action: input.action,
          ...(input.answers ? { answers: input.answers } : {}),
          ...(input.observation ? { observation: input.observation } : {}),
        },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }

  // ---- internals ----------------------------------------------------------

  /**
   * A write transaction with the change seam around it. Returns a runner
   * like `db.transaction` does. Nested calls join the outer transaction (a
   * savepoint) and the outer one alone bumps the sequence and notifies -
   * after its commit, so a listener never sees an uncommitted row. A
   * transaction that throws discards what it collected.
   */
  private write<T>(fn: () => T): () => T {
    const inner = this.db.transaction(fn);
    return () => {
      if (this.depth > 0) {
        this.depth += 1;
        try {
          return inner();
        } finally {
          this.depth -= 1;
        }
      }
      this.depth = 1;
      let seq = 0;
      let result: T;
      try {
        result = this.db.transaction(() => {
          const value = inner();
          if (this.hasPendingChange()) seq = this.bumpSeq();
          return value;
        })();
      } catch (caught) {
        this.pending = freshPending();
        throw caught;
      } finally {
        this.depth = 0;
      }
      const pending = this.pending;
      this.pending = freshPending();
      if (seq > 0) {
        const change: TaskChange = {
          seq,
          taskIds: [...pending.taskIds],
          events: pending.events,
          removed: [...pending.removed],
          reset: pending.reset,
          ...(pending.republish ? { republish: true as const } : {}),
        };
        for (const listener of this.listeners) {
          try {
            listener(change);
          } catch (caught) {
            console.warn("[tasks] change listener failed:", caught);
          }
        }
      }
      return result;
    };
  }

  private hasPendingChange(): boolean {
    const { taskIds, events, removed, reset } = this.pending;
    return (
      this.pending.presentation ||
      reset ||
      taskIds.size > 0 ||
      events.length > 0 ||
      removed.size > 0
    );
  }

  private bumpSeq(): number {
    const row = this.db
      .prepare("UPDATE task_board SET seq = seq + 1 WHERE id = 1 RETURNING seq")
      .get() as { seq: number } | undefined;
    if (!row) throw new Error("task_board row missing; migration 20 did not run.");
    return row.seq;
  }

  private touch(id: string): void {
    this.pending.taskIds.add(id);
  }

  /**
   * Every row write. A patch that moves a row to a closed status always
   * carries `closed_at` (WI-7): a closed row without one is invisible to the
   * board's recent window, so no close path may forget it.
   */
  private patch(id: string, patch: Parameters<TaskStore["update"]>[1]): void {
    // Date source transitions, not unrelated edits or resource refreshes.
    if ("gate" in patch || "startPolicy" in patch || patch.status === "open" || patch.startNotice) {
      const before = this.mustGet(id);
      const policyChanged =
        (patch.startPolicy !== undefined && patch.startPolicy !== before.startPolicy) ||
        (patch.status === "open" && before.status !== "open") ||
        Boolean(patch.startNotice);
      const gateChanged =
        "gate" in patch &&
        (patch.gate?.kind !== before.gate?.kind ||
          patch.gate?.ref !== before.gate?.ref ||
          patch.gate?.until !== before.gate?.until);
      if ((before.status === "open" || patch.status === "open") && (policyChanged || gateChanged)) {
        const shape = patch.shape ?? before.shape ?? { kind: "unclear" as const };
        const at = patch.updatedAt ?? this.now();
        patch = {
          ...patch,
          shape: {
            ...shape,
            start_wait_since: {
              ...before.shape?.start_wait_since,
              ...(policyChanged ? { policy: at } : {}),
              ...(gateChanged ? { gate: at } : {}),
            },
          },
        };
      }
    }
    const closing = patch.status === "done" || patch.status === "dropped";
    const stamped =
      closing && patch.closedAt == null
        ? { ...patch, closedAt: patch.updatedAt ?? this.now() }
        : patch;
    this.store.update(id, stamped);
    this.touch(id);
  }

  /**
   * Every timeline write. The event is written once, on its own task, and
   * names the other tasks it concerns (`concernsOf`) in the same
   * transaction; those tasks are touched so their readers read it.
   */
  private addEvent(event: InsertTaskEvent, about: readonly string[] = []): number {
    const id = this.events.insert(event);
    this.touch(event.taskId);
    const concerns = this.concernsOf(event, about);
    if (concerns.length > 0) {
      this.events.insertConcerns(id, concerns);
      for (const concern of concerns) this.touch(concern.taskId);
    }
    this.pending.events.push({
      id,
      taskId: event.taskId,
      at: event.at,
      actor: event.actor,
      kind: event.kind,
      text: event.text,
      data: event.data ?? null,
      ref: event.ref ?? null,
      feed: event.feed ?? true,
    });
    this.compactTimeline(event.taskId);
    return id;
  }

  /**
   * Fold the oldest ordinary events of an over-cap timeline into one
   * `compacted` row. Prospective provenance stays verbatim so its contract,
   * lineage and control evidence remain available to offline readers. Runs
   * inside the write that pushed the timeline past the target. The fold
   * takes whole timestamps: compactable events sharing the boundary's
   * millisecond go with it, so the compacted row - stamped at the boundary -
   * sorts before everything it stands for.
   */
  private compactTimeline(taskId: string): void {
    const count = this.events.countFor(taskId);
    if (count <= TIMELINE_CAP) return;
    const oldest = this.events.listOldest(
      taskId,
      count - TIMELINE_KEEP + 1,
      COMPACTION_EXEMPT_KINDS,
    );
    const boundary = oldest.at(-1)?.at;
    if (boundary === undefined) return;
    const upTo = this.events.listUpTo(taskId, boundary, COMPACTION_EXEMPT_KINDS);
    const compactableCount = this.events.countFor(taskId, COMPACTION_EXEMPT_KINDS);
    const folded = upTo.length < compactableCount ? upTo : oldest;
    if (folded.length <= 1) return;
    const data: CompactedEventData = { folded: 0, firstAt: boundary, lastAt: boundary, kinds: {} };
    for (const event of folded) {
      const prior = event.kind === "compacted" ? asCompacted(event.data) : null;
      if (prior) {
        data.folded += prior.folded;
        data.firstAt = Math.min(data.firstAt, prior.firstAt);
        for (const [kind, n] of Object.entries(prior.kinds)) {
          data.kinds[kind] = (data.kinds[kind] ?? 0) + n;
        }
        keepLatest(data, prior.plan, prior.planAt ?? 0, prior.programLines);
        continue;
      }
      data.folded += 1;
      data.firstAt = Math.min(data.firstAt, event.at);
      data.kinds[event.kind] = (data.kinds[event.kind] ?? 0) + 1;
      const line = event.data?.programLine as { op?: unknown; n?: unknown } | undefined;
      keepLatest(
        data,
        event.kind === "progress" ? event.data?.plan : undefined,
        event.at,
        (line?.op === "log" || line?.op === "phase") && typeof line.n === "number"
          ? { [line.op]: line.n }
          : undefined,
      );
    }
    this.events.deleteIds(folded.map((event) => event.id));
    const compacted: InsertTaskEvent = {
      taskId,
      at: boundary,
      actor: "host",
      kind: "compacted",
      text: `${data.folded} earlier events folded`,
      data,
      feed: false,
    };
    const id = this.events.insert(compacted);
    this.pending.events.push({ ...compacted, id, data, ref: null, feed: false });
  }

  /**
   * The other tasks an event concerns (docs/task-record.md, "Whom an event
   * concerns"), read only from the typed links as they stand when it is
   * written: a link's other end; for a milestone (`isMilestone`), the
   * parent, the tasks it blocks, the origin it was filed from, the task
   * its basis names, and the task it replaced together with that one's own
   * (`via`); and the tasks a
   * writer names (`about`, such as the blockers a refused merge waits on),
   * each by the link that joins it to the event's task.
   */
  private concernsOf(event: InsertTaskEvent, about: readonly string[]): TaskConcern[] {
    const found = new Map<string, TaskConcern>();
    const add = (taskId: string, relation: TaskConcernRelation, via: string | null) => {
      if (taskId !== event.taskId && !found.has(taskId) && this.store.get(taskId)) {
        found.set(taskId, { taskId, relation, via });
      }
    };
    const data = event.data ?? {};
    if ((event.kind === "linked" || event.kind === "unlinked") && typeof data.fromId === "string") {
      const type = data.type as TaskLinkType;
      add(data.fromId, LINK_END_RELATION[type] ?? "related", null);
    }
    if (isMilestone(event)) {
      const seen = new Set<string>([event.taskId]);
      const walk = (id: string, via: string | null) => {
        const record = this.store.get(id);
        if (!record) return;
        if (record.parentId) add(record.parentId, "part", via);
        for (const link of this.links.listFrom(id)) {
          if (link.type === "blocks") add(link.toId, "blocker", via);
          else if (link.type === "discovered-from") add(link.toId, "follow-up", via);
        }
        for (const link of this.links.listTo(id, "replaced-by")) {
          add(link.fromId, "replacement", via);
          if (seen.has(link.fromId)) continue;
          seen.add(link.fromId);
          walk(link.fromId, link.fromId);
        }
      };
      walk(event.taskId, null);
      // The task it names as its basis reads what became of the work built
      // on it (INF-976), closed or not.
      const basis = this.store.get(event.taskId)?.shape?.basis;
      const built = basis ? this.resolve(basis) : undefined;
      if (built) add(built.id, "built-on", null);
    }
    for (const taskId of about) {
      const relation = this.relationBetween(event.taskId, taskId);
      if (relation) add(taskId, relation, null);
    }
    return [...found.values()];
  }

  /** How task `from` stands to task `to` by the one link or parent edge that joins them. */
  private relationBetween(from: string, to: string): TaskConcernRelation | undefined {
    const record = this.store.get(from);
    const other = this.store.get(to);
    if (!record || !other) return undefined;
    if (record.parentId === to) return "part";
    if (other.parentId === from) return "parent";
    for (const link of this.links.listFrom(from)) {
      if (link.toId === to) return LINK_FROM_RELATION[link.type];
    }
    for (const link of this.links.listTo(from)) {
      if (link.fromId === to) return LINK_END_RELATION[link.type];
    }
    return undefined;
  }

  private mustGet(id: string): TaskRecord {
    const record = this.store.get(id);
    if (!record) throw new Error(`Unknown task "${id}".`);
    return record;
  }

  private resolveProject(repoId: string | null): ProjectRecord {
    if (repoId) {
      const project = this.projects.forRepo(repoId);
      if (project) return project;
    }
    return this.projects.scratch();
  }

  private mergeDelivery(record: TaskRecord, patch: Partial<TaskDelivery>): TaskDelivery {
    const mode =
      patch.mode ??
      record.delivery?.mode ??
      deliveryForRecord(
        record,
        record.repoId ? this.options.repos?.get(record.repoId)?.delivery : undefined,
      );
    const delivery = { ...(record.delivery ?? {}), ...patch, mode };
    // Kept files own the bytes. CI polls and event rows never copy transcripts.
    if (delivery.liveValidation)
      delivery.liveValidation = {
        ...delivery.liveValidation,
        runs: delivery.liveValidation.runs.map((run) => ({
          ...run,
          evidence: run.evidence.map(({ text: _transcript, ...metadata }) => metadata),
        })),
      };
    return delivery;
  }

  /**
   * Re-key a task into another project (inside the caller's transaction).
   * Only an open row with no workspace may move: a worktree is bound to a
   * repo, and a crewmate's brief already names the project it works in.
   * The subtree follows, so children never end up in a foreign project.
   * The moved task takes `repoId`, so its working copy, pull request and
   * checks are where it lands (INF-8): the new parent's on a re-parent, as
   * `create` gives a child, else the project's; where that is none
   * (Scratch, or a parent with none) it keeps its own. Each part takes what
   * its parent takes, as `create` gives a child, unless it is bound to a
   * repository of its own, which it keeps. A removed project takes no task,
   * and a repository with no remote takes no row the captain asked to ship
   * as a pull request.
   */
  private moveWithin(
    record: TaskRecord,
    projectId: string,
    actor: TaskEventActor,
    at: number,
    repoId?: string | null,
  ): void {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Unknown project "${projectId}".`);
    if (project.archivedAt !== null) {
      throw new TaskGraphRefusal(
        `Refused: ${project.name} was removed, so ${record.key || record.id} cannot move there.`,
      );
    }
    if (record.status !== "open" || record.worktreeDir || record.placement) {
      throw new TaskGraphRefusal(
        `Refused: ${record.key || record.id} is ${record.placement ? "committed to a computer" : record.status === "open" ? "bound to a workspace" : record.status} and cannot move to another project; only open work that has not started can.`,
      );
    }
    const descendants = this.descendants(record.id);
    for (const descendant of descendants) {
      if (descendant.status !== "open" || descendant.worktreeDir || descendant.placement) {
        throw new TaskGraphRefusal(
          `Refused: its child ${descendant.key || descendant.id} is ${descendant.placement ? "committed to a computer" : descendant.status === "open" ? "bound to a workspace" : descendant.status}, so the subtree cannot move to another project.`,
        );
      }
    }
    const target = repoId === undefined ? project.repoId : repoId;
    const rows = [record, ...descendants];
    const before = new Map(rows.map((row) => [row.id, row.repoId]));
    const after = new Map<string, string | null>();
    const moves = rows.map((row) => {
      let to = row.repoId;
      if (row.id === record.id) to = target ?? row.repoId;
      // A part that had its parent's repository, or none, followed it there.
      else if (row.parentId && (row.repoId === null || row.repoId === before.get(row.parentId)))
        to = after.get(row.parentId) ?? null;
      after.set(row.id, to);
      return { row, repoId: to };
    });
    // As a plan is refused a direct-pr ask with no remote to open it on
    // (CrewSupervisor.resolveSpawnDelivery), before anything is written.
    for (const { row, repoId: to } of moves) {
      if (!to || to === row.repoId || !this.options.repos) continue;
      const repo = this.options.repos.get(to);
      if (repo?.kind === "personal" || repo?.origin) continue;
      if (deliveryForRecord(row, "local-only") !== "direct-pr") continue;
      const name = repo?.name ?? project.name;
      const handle = row.key || row.id;
      throw new TaskGraphRefusal(
        `Refused: ${handle} asks to ship as a pull request (direct-pr), and ${name} has no remote to open one on, so ${handle} cannot move there. Configure a remote for ${name}, or set ${handle}'s delivery to local-only first.`,
      );
    }
    for (const { row, repoId: to } of moves) {
      const { seq, key } = this.projects.allocateSeq(project.id);
      this.patch(row.id, { projectId: project.id, key, seq, repoId: to, updatedAt: at });
      this.addEvent({
        taskId: row.id,
        at,
        actor,
        kind: "moved",
        text: `moved to ${project.name} as ${key} (was ${row.key || row.id})`,
        data: {
          fromProjectId: row.projectId,
          toProjectId: project.id,
          fromKey: row.key,
          toKey: key,
          ...(to !== row.repoId ? { fromRepoId: row.repoId, toRepoId: to } : {}),
        },
        feed: false,
      });
    }
  }

  /**
   * Whether following `blocks` edges outward from `start` (the tasks it
   * blocks, the tasks they block, ...) reaches `target`. Used to refuse a
   * new edge that would close a cycle: from -> to is a cycle exactly when
   * `to` already blocks `from`, transitively.
   */
  private blocksReaches(start: string, target: string): string[] | undefined {
    const seen = new Set<string>([start]);
    const stack = [[start]];
    while (stack.length > 0) {
      const path = stack.pop() as string[];
      const current = path[path.length - 1] as string;
      for (const link of this.links.listFrom(current, "blocks")) {
        if (link.toId === target) return [...path, target];
        if (!seen.has(link.toId)) {
          seen.add(link.toId);
          stack.push([...path, link.toId]);
        }
      }
    }
    return undefined;
  }

  /**
   * The one writer of a task's references (INF-1296 piece 2): each kind's
   * rule is checked (`referenceRefusal`), and a refusal is a graph refusal
   * that rolls the write back. The task must already have a shape, which
   * reads it under its older field.
   */
  private recordReference(
    task: TaskRecord,
    kind: TaskReferenceKind,
    ref: string,
    target: TaskRecord | undefined,
    actor: TaskEventActor,
    at: number,
  ): void {
    const refused = referenceRefusal(kind, { task, ref, target });
    if (refused) throw new TaskGraphRefusal(refused);
    this.references.set(task.id, {
      kind,
      ref,
      targetId: target?.id ?? null,
      actor,
      recordedAt: at,
    });
    this.touch(task.id);
  }

  /**
   * A replaced-by link carries the live waits with the work (INF-1826): each
   * live task waiting on `fromId` now waits on `toId`, and each wait of
   * `fromId`'s own on live work becomes `toId`'s, keeping its merge mark and
   * when it began. A link between the two ends and the host's own delivery
   * machinery (a review) stay where they are, and so does a wait whose move
   * would close a cycle. Baseline waits on a delivery record are not links
   * and do not move.
   */
  private moveWaits(fromId: string, toId: string, actor: TaskEventActor, at: number): void {
    const moves = (other: TaskRecord | undefined): other is TaskRecord =>
      !!other && other.id !== fromId && other.id !== toId && !TaskService.isDeliveryChild(other);
    const from = this.store.get(fromId);
    const to = this.store.get(toId);
    if (from && TaskService.isDeliveryChild(from)) return;
    if (to && TaskService.isDeliveryChild(to)) return;
    const move = (link: TaskLink, next: { fromId: string; toId: string }) => {
      try {
        this.insertLink(
          next.fromId,
          next.toId,
          "blocks",
          actor,
          at,
          link.holdsMerge,
          link.createdAt,
        );
      } catch (caught) {
        if (caught instanceof TaskGraphRefusal) return;
        throw caught;
      }
      this.links.delete(link.fromId, link.toId, "blocks");
      this.touch(link.fromId);
      this.addEvent({
        taskId: link.toId,
        at,
        actor,
        kind: "unlinked",
        text: `no longer ${LINK_WORDS.blocks} "${this.store.get(link.fromId)?.title ?? link.fromId}"`,
        data: { fromId: link.fromId, type: "blocks", movedTo: toId },
        ref: link.fromId,
        feed: false,
      });
    };
    for (const link of this.links.listFrom(fromId, "blocks")) {
      const waiter = this.store.get(link.toId);
      if (!moves(waiter) || TaskService.isClosed(waiter)) continue;
      move(link, { fromId: toId, toId: waiter.id });
    }
    for (const link of this.links.listTo(fromId, "blocks")) {
      const blocker = this.store.get(link.fromId);
      if (!moves(blocker) || !TaskService.blockerHoldsClose(blocker)) continue;
      move(link, { fromId: blocker.id, toId });
    }
  }

  private insertLink(
    fromId: string,
    toId: string,
    type: TaskLinkType,
    actor: TaskEventActor,
    at: number,
    holdsMerge = false,
    createdAt = at,
  ): boolean {
    const from = this.mustGet(fromId);
    const to = this.mustGet(toId);
    if (fromId === toId) {
      throw new TaskGraphRefusal(`Refused: a task cannot be linked to itself (${type}).`);
    }
    if (type === "blocks") {
      // Keep structural refusal even for historical ordinary links.
      const structural = this.blocksReaches(toId, fromId);
      if (structural) {
        throw new TaskGraphRefusal(
          `Refused: ${to.key || toId} already blocks ${from.key || fromId} (directly or through other tasks); "${from.key || fromId} blocks ${to.key || toId}" would close a cycle and nothing could ever start. ${waitCycleWords(this, [toId, ...structural.toReversed()])} ${fixedHoldWords("recorded-path")}`,
        );
      }
      const cycle = liveWaitCycle(this, toId, fromId, TaskService.blockerHoldsClose);
      if (cycle) throw new TaskGraphRefusal(`Refused: ${waitCycleWords(this, cycle)}`);
    }
    const created = this.links.insert({
      fromId,
      toId,
      type,
      actor,
      createdAt,
      holdsMerge: type === "blocks" && holdsMerge,
    });
    if (created && type === "replaced-by") this.moveWaits(fromId, toId, actor, at);
    if (created) {
      // Both ends' views change (blockedBy on one, blocks on the other).
      this.touch(fromId);
      this.addEvent({
        taskId: toId,
        at,
        actor,
        kind: "linked",
        text:
          type === "blocks"
            ? `waits for "${from.title}" (${from.key || from.id})`
            : type === "related"
              ? `related to "${from.title}" (${from.key || from.id})`
              : type === "replaced-by"
                ? `replaces "${from.title}" (${from.key || from.id})`
                : `follow-up filed: "${from.title}" (${from.key || from.id})`,
        data: { fromId, type },
        ref: fromId,
        feed: false,
      });
    }
    return created;
  }
}
