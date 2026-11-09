import type { TaskLifecycleOp } from "@shared/cards";
import type { ChangeRecord } from "@shared/change";
import { fixedHoldWords, type OverridableHold } from "@shared/holds";
import type { ReasoningChoice } from "@shared/modelSlots";
import { type PlacementRequirements, placementRequirementsSchema } from "@shared/placement";
import { TASK_CARD_VIA } from "@shared/provenance";
import { reasoningWord } from "@shared/reasoning";
import { DROP_BEFORE_START } from "@shared/recordDrop";
import { deliveryForRecord, opensPullRequest, type RepoView } from "@shared/repos";
import type { WorkShape } from "@shared/routingPolicy";
import type { PlanItem } from "@shared/taskPlan";
import {
  type EffectiveTaskPolicies,
  effectiveTaskPolicies,
  POLICY_CARE_BOUND,
  POLICY_DELIVERY_WORDS,
  POLICY_MERGING_WORDS,
  POLICY_SOURCE_WORDS,
  type PolicyRepo,
  type TaskPolicyEdits,
} from "@shared/taskPolicies";
import { QUEUE_POLICY } from "@shared/taskQueue";
import type { DropEffects } from "@shared/tasks";
import type { RepetitionNotice, ToolObservation } from "@shared/toolCompletion";
import { CARE_WORDS } from "@shared/vocabulary";
import { amendBriefGoal, type BriefPart, type SpawnIntent } from "../orchestrator/intentBrief";
import { KIND_SOURCE } from "../routing/kindClassifier";
import { tierFor } from "../routing/policy";
import { isHostRaisedShape } from "../storage/changeStore";
import type { AppDatabase } from "../storage/db";
import type { ProjectRecord, ProjectStore } from "../storage/projectStore";
import type {
  ConcernedTaskEvent,
  InsertTaskEvent,
  TaskConcern,
  TaskEvent,
  TaskEventActor,
} from "../storage/taskEventStore";
import {
  REFERENCE_SHAPE_FIELDS,
  TASK_REFERENCE_KINDS,
  type TaskReferenceKind,
} from "../storage/taskReferenceStore";
import { TaskRepetitionStore } from "../storage/taskRepetitionStore";
import type {
  TaskActivity,
  TaskClosedReason,
  TaskDelivery,
  TaskGate,
  TaskKind,
  TaskRecord,
  TaskRetentionFields,
  TaskSearchFields,
  TaskStartPolicy,
  TaskStatus,
  TaskStore,
} from "../storage/taskStore";
import { compactBrief, expandBrief, reportHash } from "./briefReceipt";
import { latestResultOf, type ReportEntry, reportEntryOf, type TaskResult } from "./reportEntry";
import { TaskArchive } from "./taskArchive";
import { TaskCapture } from "./taskCapture";
import { TaskDeliveries } from "./taskDeliveries";
import { TaskGraph, TaskGraphRefusal } from "./taskGraph";
import { TaskPlacement } from "./taskPlacement";
import { referenceRefusal } from "./taskRelationships";
import { TaskStarts } from "./taskStarts";
import { TaskTurns } from "./taskTurns";
import { keyOrId, type TaskChangeListener, TaskWriter, withShapeKey } from "./taskWriter";
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
 * The seam and the stores live in `TaskWriter` (taskWriter.ts), and the
 * timeline's fold of old events in timelineCompaction.ts. This class keeps
 * the record's own writes and reaches seven parts over the same writer,
 * each in its own file: `graph` (links, waits and derived reads),
 * `capture` (asks, cards and origins), `starts` (dispatch and start
 * attempts), `placement` (where work runs, its gate and moves), `delivery`
 * (change evidence, required actions and write asks), `turns` (reports,
 * steers and idle) and `archive` (conversations, references, import and
 * purge). A part is still this one writer: it writes only through it.
 *
 * Refusals the agent should read as tool text - a cycle, a parent with
 * open children, a move a workspace forbids - are `TaskGraphRefusal`
 * errors; a plain Error is a programming fault or an unknown id.
 */

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
   * follows its parent's or project's again. The crew's placement checks
   * the ask first (`TaskPlacement.runsOnRefusal`) and writes `words`, the
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
      // A started task's move into the backlog and out of it (INF-2062).
      if (data.backlog === "entered") return "unqueue-task";
      if (data.backlog === "left") return "start-task";
      return data.startPolicy === QUEUE_POLICY["queue-task"]
        ? "queue-task"
        : data.startPolicy === QUEUE_POLICY["unqueue-task"]
          ? "unqueue-task"
          : undefined;
    case "steered":
      return "continue-task";
    case "interrupted":
      return data.effect === "aborted-turn" || data.effect === "abort-failed" || data.backlog
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
  const key = keyOrId(carrier);
  return {
    status: "done",
    reason: "superseded",
    actor,
    text: `Carried on by ${key}`,
    data: { replacedBy: carrier.id, carriedBy: key },
  };
}

export type TaskServiceOptions = {
  db: AppDatabase;
  /** Share the host's read-only facts alongside one synchronous task projection. */
  readFacts?<T>(read: () => T): T;
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
export function splitReferences(shape: WorkShape | null): {
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

export class TaskService {
  /** Links, waits, carriers and the parent and close rules (taskGraph.ts). */
  readonly graph: TaskGraph;
  /** Asks and the question, decision and operation kinds filed from them (taskCapture.ts). */
  readonly capture: TaskCapture;
  /** The queue and the start of work (taskStarts.ts). */
  readonly starts: TaskStarts;
  /** Where work runs: moves between computers, placement and the workspace (taskPlacement.ts). */
  readonly placement: TaskPlacement;
  /** The change, its validation, write asks and required actions (taskDeliveries.ts). */
  readonly delivery: TaskDeliveries;
  /** A crewmate's turns: activity, reports, steers and replies (taskTurns.ts). */
  readonly turns: TaskTurns;
  /** Recorded sessions and specifications, import, discards and the purge (taskArchive.ts). */
  readonly archive: TaskArchive;
  readonly projects: ProjectStore;
  private readonly writer: TaskWriter;

  constructor(private readonly options: TaskServiceOptions) {
    this.writer = new TaskWriter(options);
    this.projects = this.writer.projects;
    this.graph = new TaskGraph(this.writer, this);
    this.capture = new TaskCapture(this.writer, this);
    this.placement = new TaskPlacement(this.writer);
    this.delivery = new TaskDeliveries(this.writer, this);
    this.turns = new TaskTurns(this.writer, this);
    this.archive = new TaskArchive(this.writer, this);
    // Boot: a turn a dead process left streaming is interrupted, not
    // resurrected; an open row keeps waiting. The starts then return a
    // dispatch claimed before its worktree existed to the ready query.
    this.writer.store.interruptLeftRunning(this.writer.now());
    this.starts = new TaskStarts(this.writer, this);
    const missing = this.writer.store.countMissingInvariants();
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
    this.writer.listeners.add(listener);
    return () => {
      this.writer.listeners.delete(listener);
    };
  }

  /** Owner-only completion facts; enqueue shares this transaction's database. */
  observeTool(
    id: string,
    event: ToolObservation,
    enqueue: (notice: RepetitionNotice) => void,
  ): void {
    new TaskRepetitionStore(this.writer.db).consume(id, event, enqueue);
  }

  /** Publish derived host facts without rewriting activity or its idle clock. */
  refreshPresentation(taskIds: readonly string[]): void {
    this.writer.write(() => {
      for (const id of taskIds) if (this.writer.store.has(id)) this.writer.touch(id);
      // Its own commit alone is a republish; inside another write it joins that one.
      if (this.writer.depth === 1) this.writer.pending.republish = true;
    })();
  }

  /** A derived presentation changed, without changing task state or its clocks. */
  invalidatePresentation(): void {
    this.writer.write(() => {
      this.writer.pending.presentation = true;
    })();
  }

  /** The board sequence of the last committed mutation (0 on a fresh database). */
  boardSeq(): number {
    return this.writer.store.boardSeq();
  }

  // ---- reads --------------------------------------------------------------

  /** One synchronous projection shares task reads, never a conversation or turn's writes. */
  readProjection<T>(read: () => T, known: readonly TaskRecord[] = []): T {
    const project = () => this.writer.store.readProjection(read, known);
    const run = () => (this.options.readFacts ? this.options.readFacts(project) : project());
    if (this.writer.projection) return run();
    this.writer.projection = {
      workAfter: new Map(),
      linksTo: new Map(),
      linksFrom: new Map(),
      blockers: new Map(),
      blocksIn: new Map(),
      activeWaiters: new Map(),
      facts: new Map(),
    };
    try {
      return run();
    } finally {
      this.writer.projection = undefined;
    }
  }

  /** First first-mate action after a request, including closed successor work. */
  firstmateActedSince(record: TaskRecord, since: number): number | undefined {
    let first = this.writer.events.firstFirstmateActAfter(record.id, since);
    const take = (at: number | null | undefined) => {
      if (at != null && at > since && (first === undefined || at < first)) first = at;
    };
    take(this.writer.store.firstChildActivityAfter(record.id, since));
    for (const other of this.graph.builtOn(record.id)) {
      take(other.createdAt);
      take(other.startedAt);
    }
    return first;
  }

  /** A reader's pure derived fact, shared only inside the current synchronous projection. */
  projectedFact<T>(subject: object, owner: symbol, read: () => T): T {
    const facts = this.writer.projection?.facts;
    if (!facts) return read();
    let readings = facts.get(subject);
    if (!readings) {
      readings = new Map();
      facts.set(subject, readings);
    }
    if (readings.has(owner)) return readings.get(owner) as T;
    const value = read();
    // A write during the read clears the projection; never repopulate its old facts.
    if (facts.get(subject) === readings) readings.set(owner, value);
    return value;
  }

  get(id: string): TaskRecord | undefined {
    return this.writer.store.get(id);
  }

  /** The change a task carries on its own branch, as its record keeps it (INF-1868 piece 1), or undefined. */
  changeFor(taskId: string): ChangeRecord | undefined {
    return this.writer.store.changes.forTask(taskId);
  }

  /** Every change a task names, its own first, then each other pull request (INF-2490). */
  changesFor(taskId: string): ChangeRecord[] {
    return this.writer.store.changes.allForTask(taskId);
  }

  byKey(key: string): TaskRecord | undefined {
    return this.writer.store.byKey(key);
  }

  list(): TaskRecord[] {
    return this.writer.store.list();
  }

  /** Rows waiting to start (the old queued set, every kind). */
  listOpen(): TaskRecord[] {
    return this.writer.store.listByStatus("open");
  }

  /** Rows a crewmate holds or held and left resumable. */
  listActive(): TaskRecord[] {
    return this.writer.store.listByStatus("active");
  }

  /** The live set: everything not closed. */
  listLive(): TaskRecord[] {
    return this.writer.store.listByStatus("open", "active");
  }

  /** How many active rows each computer that runs work holds, by its id, counted without composing task records. */
  activeCountsByDevice(): Map<string, number> {
    return this.writer.store.countActiveByDevice();
  }

  /** Recorded overrides standing on this computer, read without composing task records. */
  passingOverridesForComputer(computerId: string, kind: OverridableHold): string[] {
    return this.writer.store.passingOverridesForComputer(computerId, kind);
  }

  /** Every row holding a computer move, open or closed, oldest first, read without the rest. */
  listWithComputerMove(): TaskRecord[] {
    return this.writer.store.listWithComputerMove();
  }

  /** The live set and every row closed at or after `since`, oldest first. */
  listLiveOrClosedSince(since: number): TaskRecord[] {
    return this.writer.store.listLiveOrClosedSince(since);
  }

  /** Each closed row's search fields, oldest first, without reading the rest of it. */
  listClosedSearchFields(): TaskSearchFields[] {
    return this.writer.store.listClosedSearchFields();
  }

  /** Each closed row's retention fields with its close in `[from, upTo]`, without composing it. */
  listClosedRetentionFields(from: number | null, upTo: number | null): TaskRetentionFields[] {
    return this.writer.store.listClosedRetentionFields(from, upTo);
  }

  /** These tasks' retention fields, those that still exist, without composing them. */
  retentionFields(ids: readonly string[]): TaskRetentionFields[] {
    return this.writer.store.retentionFields(ids);
  }

  /** The closed tasks on this computer whose working copy the record still counts as present. */
  closedPresentOn(deviceId: string): string[] {
    return this.writer.store.closedPresentOn(deviceId);
  }

  /** Whether any row holds this status, answered without reading or composing one. */
  hasStatus(status: TaskStatus): boolean {
    return this.writer.store.hasStatus(status);
  }

  /** How many rows of this kind hold this status, counted without reading them. */
  count(status: TaskStatus, kind: TaskKind): number {
    return this.writer.store.count(status, kind);
  }

  /** Whether any row is of this kind, answered without reading or composing one. */
  hasKind(kind: TaskKind): boolean {
    return this.writer.store.hasKind(kind);
  }

  /**
   * Whether a task of the captain's has closed done, answered without
   * reading or composing one: work, a decision, or a question that answered
   * one of the captain's messages. A host note - the welcome, a release's
   * note - answers no message, and an `operation` row is the trail of an
   * app change, so neither is a task the captain finished.
   */
  hasFinishedTask(): boolean {
    return this.writer.store.hasFinishedTask();
  }

  /**
   * How many of the captain's crewmates have finished their tasks, counted
   * up to `upTo` without reading them (docs/first-launch.md, "The
   * create-your-own-panel slot"): work a crewmate started that closed done.
   * A question or decision the Firstmate answered itself had no crewmate,
   * work closed done before one started was nobody's, and dropped work did
   * not finish, so none of them counts.
   */
  finishedCrewmates(upTo: number): number {
    return this.writer.store.countFinishedCrewmates(upTo);
  }

  /** These rows, oldest first; an unknown id reads as nothing. */
  getMany(ids: readonly string[]): TaskRecord[] {
    return this.writer.store.getMany(ids);
  }

  /** How many children each of these parents has, and how many of them closed. */
  childCounts(parentIds: readonly string[]): Map<string, { total: number; closed: number }> {
    return this.writer.store.childCounts(parentIds);
  }

  timeline(id: string): TaskEvent[] {
    return this.writer.events.listFor(id);
  }

  /** Latest host-observed recovery fact; no session is opened by this read. */
  restartObservation(id: string): Pick<TaskEvent, "at" | "text"> | undefined {
    return this.writer.events.latestRestartObservation(id);
  }

  /** One timeline event by its id, whatever its task; undefined once it is gone. */
  eventByIdentity(identity: string): TaskEvent | undefined {
    return this.writer.events.byIdentity(identity);
  }

  event(eventId: number): TaskEvent | undefined {
    return this.writer.events.get(eventId);
  }

  /** Every report on the task as its typed entry, oldest first (docs/task-record.md). */
  reportEntries(id: string): ReportEntry[] {
    return this.writer.events
      .listFor(id)
      .filter((event) => event.kind === "report")
      .map(reportEntryOf);
  }

  /** Current and previous reports, the two entries the report sorter compares. */
  lastReportEntries(id: string): ReportEntry[] {
    return this.writer.events.lastReports(id).map(reportEntryOf);
  }

  /**
   * The task's latest typed result (INF-799): the newest report entry that
   * carried one, or the copy an older release kept on its delivery facts
   * while no later report carried another (`latestResultOf`).
   */
  latestResult(id: string): TaskResult | undefined {
    const record = this.writer.store.get(id);
    if (!record) return undefined;
    const newest = this.writer.events.latestWithObject(id, "report", "result");
    return latestResultOf(newest ? reportEntryOf(newest) : undefined, record.delivery?.result);
  }

  /** When the task's crewmate last reported (INF-1244: its crew line says how long ago). */
  lastReportAt(id: string): number | undefined {
    return this.writer.events.latestAt(id, "report");
  }

  /**
   * The events other tasks wrote that concern this one, in timeline order,
   * each with how its task stands to this one (docs/task-record.md, "Whom
   * an event concerns"). The task's Activity reads them as rows of their own.
   */
  concerning(id: string): ConcernedTaskEvent[] {
    return this.writer.events.listConcerning(id);
  }

  /** Whom each event concerns, by event id: what the task export carries with each event. */
  eventConcerns(): Map<number, TaskConcern[]> {
    const byEvent = new Map<number, TaskConcern[]>();
    for (const { eventId, ...concern } of this.writer.events.listAllConcerns()) {
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
    return this.writer.events
      .listByActorViaSince("captain", TASK_CARD_VIA, since)
      .flatMap((event): TaskCardClick[] => {
        const op = taskCardOp(event);
        const panel = typeof event.data?.panel === "string" ? event.data.panel : undefined;
        return op ? [{ taskId: event.taskId, at: event.at, op, ...(panel ? { panel } : {}) }] : [];
      });
  }

  /**
   * Pin the brief a first turn serves independently of later report
   * replacement; the standing directions a turn adds are not part of it.
   * The report text it copied off the record is kept as a
   * reference to its event where that is smaller (`./briefReceipt.ts`);
   * `servedBrief` reads it back whole.
   */
  recordBrief(id: string, brief: readonly BriefPart[]): void {
    const { text, refs } = compactBrief(brief);
    const run = this.writer.write(() => {
      this.writer.mustGet(id);
      this.writer.addEvent({
        taskId: id,
        at: this.writer.now(),
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
        own = this.writer.events.listFor(ref.task).filter((event) => event.kind === "report");
        reports.set(ref.task, own);
      }
      const named = own.find((event) => event.id === ref.event);
      if (named && reportHash(named.text) === ref.sha256) return named.text;
      return own.find((event) => reportHash(event.text) === ref.sha256)?.text;
    });
  }

  /** The newest feed-worthy timeline events across every task, newest first. */
  /**
   * The contribution channel's backlog (roadmap 1.4): the R2 `decided`
   * records newer than the last send, newest first and capped, and the
   * whole backlog's size. Reads only; the sharing service redacts them.
   */
  decisionBacklog(since: number, limit: number): TaskEvent[] {
    return this.writer.events.listByKindSince("decided", since, limit);
  }

  decisionBacklogCount(since: number): number {
    return this.writer.events.countByKindSince("decided", since);
  }

  listFeedEvents(limit: number): TaskEvent[] {
    return this.writer.events.listFeed(limit);
  }

  /** A blocker clears its wait only when done; a dropped one can never clear. */
  static blockerCleared(blocker: Pick<TaskRecord, "status">): boolean {
    return blocker.status === "done";
  }

  /** Closed = no longer open or active: done or dropped. */
  static isClosed(record: Pick<TaskRecord, "status">): boolean {
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
    return this.writer.resolve(ref);
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
  static blockerHoldsClose(blocker: Pick<TaskRecord, "status">): boolean {
    return blocker.status === "open" || blocker.status === "active";
  }

  // ---- writes -------------------------------------------------------------

  create(input: CreateTaskInput): TaskRecord {
    const at = input.createdAt ?? this.writer.now();
    const actor = input.actor ?? "firstmate";
    const run = this.writer.write((): TaskRecord => {
      // A child inherits its parent's project (and repo, unless bound to
      // one of its own) - the hierarchy is intra-project by construction.
      const parent = input.parentId ? this.writer.mustGet(input.parentId) : undefined;
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
      this.writer.store.insert({ ...record, shape: stored });
      for (const [kind, ref, target] of targets)
        this.recordReference(record, kind, ref, target, actor, at);
      this.writer.touch(record.id);
      // The insert writes the fixed columns; the computer rides the same
      // write as a patch, so one change carries the row and its placement.
      if (input.deviceId) this.writer.patch(record.id, { deviceId: input.deviceId });
      this.writer.addEvent({
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
        this.graph.insertLink(blockerId, record.id, "blocks", actor, at);
      }
      return record;
    });
    return run();
  }

  // ---- graph writes (P2) --------------------------------------------------

  /** A task's policies now, read with its project's settings; none for a missing record. */
  policiesOf(record: TaskRecord | undefined): EffectiveTaskPolicies | null {
    if (!record) return null;
    return effectiveTaskPolicies(
      record,
      record.repoId ? this.options.repos?.get(record.repoId) : undefined,
    );
  }

  /** Edit the plain fields of a record; one `note` event lists what changed. */
  updateFields(id: string, patch: UpdateTaskPatch, actor: TaskEventActor): string[] {
    const at = this.writer.now();
    const run = this.writer.write((): string[] => {
      let record = this.writer.mustGet(id);
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
        this.writer.patch(id, {
          status: "open",
          closedAt: null,
          closedReason: null,
          gate: { kind: "captain", ref: action.cardId },
          delivery: this.writer.mergeDelivery(record, {
            captainAction: {
              ...action,
              state: "blocked",
              generation: action.generation + 1,
              completedAt: undefined,
            },
          }),
          updatedAt: at,
        });
        this.writer.addEvent({
          taskId: id,
          at,
          actor,
          kind: "note",
          text: "The captain corrected the earlier confirmation. This does not reverse work that already continued.",
          data: { previous: action },
          feed: true,
        });
        changes.push("required action reopened; previous confirmation kept in history");
        record = this.writer.mustGet(id);
      }
      if (patch.project !== undefined) {
        const project = this.projects.byKey(patch.project) ?? this.projects.get(patch.project);
        if (!project) throw new TaskGraphRefusal(`Unknown project "${patch.project}".`);
        const moved = this.moveToProject(id, project.id, actor);
        if (moved.key !== record.key) changes.push(`moved to ${project.name} as ${moved.key}`);
        record = this.writer.mustGet(id);
      }
      if (patch.parent !== undefined) {
        const parent = patch.parent.trim() ? this.resolve(patch.parent.trim()) : undefined;
        if (patch.parent.trim() && !parent)
          throw new TaskGraphRefusal(`Unknown parent "${patch.parent}".`);
        this.setParent(id, parent?.id ?? null, actor);
        changes.push(parent ? `parent ${keyOrId(parent)}` : "parent cleared");
        record = this.writer.mustGet(id);
      }
      const unstarted =
        record.status === "open" &&
        record.startedAt === null &&
        !record.placement &&
        record.kind === "work";
      if (patch.basis !== undefined && !unstarted) {
        throw new TaskGraphRefusal("A basis can only change on open work that has not started.");
      }
      if (patch.internalStep !== undefined && !unstarted) {
        throw new TaskGraphRefusal(
          "internal_step can only change on open work that has not started.",
        );
      }
      if ((patch.resultSchema !== undefined || patch.branchFrom !== undefined) && !unstarted) {
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
        update.shape = withShapeKey(
          record.shape,
          "placement_requirements",
          patch.placementRequirements
            ? placementRequirementsSchema.parse(patch.placementRequirements)
            : undefined,
        );
        changes.push("computer requirements updated");
      }
      if (patch.basis !== undefined) {
        const basis = patch.basis.trim() ? this.resolve(patch.basis.trim()) : undefined;
        if (patch.basis.trim() && !basis)
          throw new TaskGraphRefusal(`Unknown basis "${patch.basis}".`);
        if (basis?.id === id) throw new TaskGraphRefusal("A task cannot be its own basis.");
        const ref = basis ? keyOrId(basis) : undefined;
        if (ref !== record.shape?.basis) {
          referenceEdits.push(["basis", ref, basis]);
          changes.push(ref ? `basis ${ref}` : "basis cleared");
        }
      }
      if (patch.resultSchema !== undefined) {
        update.shape = withShapeKey(
          update.shape ?? record.shape,
          "result_schema",
          patch.resultSchema || undefined,
        );
        changes.push(patch.resultSchema ? "result shape set" : "result shape cleared");
      }
      if (patch.internalStep !== undefined) {
        if (patch.internalStep !== (record.shape?.internal_step === true)) {
          update.shape = withShapeKey(
            update.shape ?? record.shape,
            "internal_step",
            patch.internalStep ? true : undefined,
          );
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
        update.shape = withShapeKey(
          update.shape ?? record.shape,
          "override_speed",
          patch.speed === null ? undefined : patch.speed,
        );
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
          update.shape = withShapeKey(current, "override_reasoning", reasoning || undefined);
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
          const shape = withShapeKey(
            withShapeKey(current, "placement_fallback_accepted", undefined),
            "override_model_id",
            model,
          );
          update.shape =
            !model && shape.kind_source === `${KIND_SOURCE.skipped}override`
              ? { ...shape, kind_source: "none" }
              : shape;
          update.difficulty = tierFor(update.shape).bucket ?? null;
          changes.push(`${model ? `model ${model}` : "model cleared"}${from}`);
        }
      }
      if (patch.runsOn !== undefined) {
        const ask = patch.runsOn.ask ?? undefined;
        const current = update.shape ?? record.shape;
        if (ask !== current?.runs_on_ask) {
          update.shape = withShapeKey(current, "runs_on_ask", ask || undefined);
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
        // Cancel pending attempts in this same transaction. The revision also
        // invalidates attempts already reading asynchronous checks.
        const cancel =
          patch.policies.delivery !== undefined ||
          (patch.policies.autonomy !== undefined && !next.autonomy.value);
        const approval = record.delivery?.mergeAuthorization;
        if (cancel) {
          update.pendingSettle = null;
          if (approval?.status === "standing") {
            update.delivery = this.writer.mergeDelivery(record, {
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
                // Approvals of its other pull requests end with it once the
                // supervisor hears the change, which tells its crewmate
                // (INF-2746, `CrewSupervisor.policiesChanged`).
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
      this.writer.patch(id, { ...update, updatedAt: at });
      for (const [kind, ref, target] of referenceEdits) {
        if (ref) this.recordReference(this.writer.mustGet(id), kind, ref, target, actor, at);
        else this.writer.references.delete(id, kind);
      }
      this.writer.addEvent({
        taskId: id,
        at,
        actor,
        kind: "note",
        text: update.verdict ? update.verdict : `updated: ${changes.join(", ")}`,
        data: {
          changes: patch,
          ...(("goal" in update || "prompt" in update || "intent" in update) &&
          this.writer.store.specifications.exists()
            ? {
                specificationRevision: this.writer.store.specifications.revision(id),
                journal: true,
              }
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
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      // The parent edge IS the review-to-builder join (captain-approved
      // fold of `review_of`, 2026-09-19): an edit here would silently sever
      // the verdict path, so delivery machinery keeps the parent the host
      // gave it.
      if (TaskService.isDeliveryChild(record) && record.parentId !== parentId) {
        throw new TaskGraphRefusal(
          `Refused: ${keyOrId(record)} is the host's own delivery work under ${record.parentId ?? "its builder"}; its parent is fixed.`,
        );
      }
      if (parentId === null) {
        if (record.parentId === null) return;
        this.writer.patch(id, { parentId: null, updatedAt: at });
        this.writer.addEvent({
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
      const parent = this.writer.mustGet(parentId);
      if (record.parentId === parentId) return;
      if (this.graph.ancestors(parentId).some((ancestor) => ancestor.id === id)) {
        throw new TaskGraphRefusal(
          `Refused: ${keyOrId(parent)} is already under ${keyOrId(record)}; making it the parent would close a cycle.`,
        );
      }
      // A parent waits on its parts until they close (INF-3167): a part that
      // waits on the task it would go under, directly or through other
      // tasks, would wait on itself, the loop the link writer refuses too.
      const cycle = liveWaitCycle(this, parentId, id, TaskService.blockerHoldsClose);
      if (cycle) {
        throw new TaskGraphRefusal(
          `Refused: ${keyOrId(parent)} would wait on its part ${keyOrId(record)}, which already waits on it. ${waitCycleWords(this, cycle)}`,
        );
      }
      if (parent.projectId !== record.projectId) {
        this.moveWithin(record, parent.projectId, actor, at, parent.repoId);
      }
      this.writer.patch(id, { parentId, updatedAt: at });
      this.writer.addEvent({
        taskId: id,
        at,
        actor,
        kind: "moved",
        text: `now under "${parent.title}" (${keyOrId(parent)})`,
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
    const at = this.writer.now();
    const run = this.writer.write((): TaskRecord => {
      const record = this.writer.mustGet(id);
      if (record.projectId !== projectId) this.moveWithin(record, projectId, actor, at);
      return this.writer.mustGet(id);
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
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.mustGet(id);
      this.writer.patch(id, { updatedAt: at });
      this.writer.addEvent({
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
    const at = this.writer.now();
    const actor = input.actor ?? "crewmate";
    const testPath = input.testPath ? normalizeTestPath(input.testPath) : undefined;
    if (input.testFailure && !testPath) {
      throw new Error("test_path is required when the follow-up is a test failure.");
    }
    const run = this.writer.write((): FileFollowupResult => {
      if (testPath) {
        const existing = this.writer.store.openByTestPath(testPath);
        if (existing) return { record: existing, duplicate: true };
      }
      const origin = this.writer.mustGet(input.originId);
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
      if (testPath) this.writer.patch(record.id, { testPath });
      this.graph.insertLink(record.id, origin.id, "discovered-from", actor, at);
      this.writer.addEvent({
        taskId: record.id,
        at,
        actor,
        kind: "note",
        text: `filed while working on "${origin.title}" (${keyOrId(origin)}): ${input.why}`,
        data: { why: input.why, originId: origin.id, news: true },
        ref: origin.id,
        feed: false,
      });
      if (input.blocksOrigin)
        this.graph.insertLink(record.id, origin.id, "blocks", actor, at, true);
      return { record: this.writer.mustGet(record.id), duplicate: false };
    });
    return run();
  }

  /**
   * The origin a crewmate filed this row from. A discovered-from edge whose
   * actor is not a crewmate is not a filing the ledger counts.
   */
  crewFilingOrigin(id: string): TaskRecord | undefined {
    const link = this.writer.links
      .listFrom(id, "discovered-from")
      .find((edge) => edge.actor === "crewmate");
    return link ? this.writer.store.get(link.toId) : undefined;
  }

  /**
   * The captain opened the record. Clears the Charted "new" mark. Idempotent
   * and silent: opening is not a verdict, so it writes no feed line.
   */
  markOpened(id: string, at = this.writer.now()): boolean {
    const run = this.writer.write((): boolean => {
      const record = this.writer.mustGet(id);
      if (!this.crewFilingOrigin(id) || record.captainOpenedAt != null) return false;
      this.writer.patch(id, { captainOpenedAt: at, updatedAt: at });
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
    const run = this.writer.write((): TaskRecord[] => {
      const record = this.writer.mustGet(id);
      const replacement = input.replacedBy ? this.writer.mustGet(input.replacedBy) : undefined;
      if (replacement) {
        const refusal = this.graph.carrierRefusal(id, replacement.id);
        if (refusal) throw new TaskGraphRefusal(refusal);
        this.graph.insertLink(id, replacement.id, "replaced-by", input.actor, this.writer.now());
      }
      const dropped: TaskRecord[] = [];
      // Deepest first, so every parent closes after its children.
      for (const descendant of this.graph.descendants(id).reverse()) {
        if (descendant.status !== "open") continue;
        this.close(descendant.id, {
          status: "dropped",
          reason: "superseded",
          actor: input.actor,
          text: `superseded - "${record.title}" (${keyOrId(record)}) was dropped`,
        });
        dropped.push(this.writer.mustGet(descendant.id));
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
    const parts = this.graph
      .descendants(id)
      .filter((descendant) => descendant.status === "open" || descendant.status === "active")
      .map((descendant) => ({
        key: keyOrId(descendant),
        title: descendant.title,
        started: descendant.status === "active" || descendant.startedAt != null,
      }))
      .sort(byKey);
    const waiting = [];
    const underway = [];
    for (const dependent of this.graph.blocking(id)) {
      const named = { key: keyOrId(dependent), title: dependent.title };
      if (dependent.status === "open") waiting.push(named);
      else if (dependent.status === "active") underway.push(named);
    }
    return { parts, waiting: waiting.sort(byKey), underway: underway.sort(byKey) };
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
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.patch(id, { updatedAt: at });
      this.writer.addEvent(
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
   * Close the record: done (landed, merged, released, answered, settled) or dropped
   * (cancelled, discarded, failed, superseded). An idle crewmate with
   * unlanded work is not a close - it stays `active` and resumable until
   * merged, landed or discarded (WI-11). Never a delete - the row, its
   * timeline and its session JSONL survive (D2).
   */
  close(id: string, input: CloseInput): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
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
      // Allow for the rest of this task ends with the task (INF-2993).
      const allowed = (record.delivery?.integrationAllowances?.length ?? 0) > 0;
      // Closing a record must never manufacture routing provenance. Keep
      // the snapshot with the closed outcome, preserving published facts.
      const delivery =
        input.delivery || closedPolicies || unsent || allowed
          ? this.writer.mergeDelivery(record, {
              ...input.delivery,
              ...(closedPolicies ? { closedPolicies } : {}),
              ...(unsent ? { writeAsks: asks?.filter((ask) => ask.sentAt !== undefined) } : {}),
              ...(allowed ? { integrationAllowances: undefined } : {}),
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
        this.placement.releasePlacement(id, record.placement.snapshot.orderId, "ended");
      this.writer.patch(id, {
        status: input.status,
        activity: null,
        closedReason: input.reason,
        closedAt: at,
        gate: null,
        delivery,
        pendingSettle: null,
        updatedAt: at,
      });
      if (input.reason === "merged" || input.reason === "landed") {
        this.delivery.activateRequiredActions(id);
        this.delivery.activateAfterMergeSteps(id);
      }
      this.writer.addEvent({
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

  /** Join cross-service writes to the task change seam; publish only after commit. */
  atomic<T>(write: () => T, publish: (value: T) => void): T {
    if (this.writer.depth > 0 || this.writer.db.inTransaction) {
      throw new Error("An atomic publication must own the outer transaction.");
    }
    const value = this.writer.write(write)();
    publish(value);
    return value;
  }

  private resolveProject(repoId: string | null): ProjectRecord {
    if (repoId) {
      const project = this.projects.forRepo(repoId);
      if (project) return project;
    }
    return this.projects.scratch();
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
        `Refused: ${project.name} was removed, so ${keyOrId(record)} cannot move there.`,
      );
    }
    if (record.status !== "open" || record.worktreeDir || record.placement) {
      throw new TaskGraphRefusal(
        `Refused: ${keyOrId(record)} is ${record.placement ? "committed to a computer" : record.status === "open" ? "bound to a workspace" : record.status} and cannot move to another project; only open work that has not started can.`,
      );
    }
    const descendants = this.graph.descendants(record.id);
    for (const descendant of descendants) {
      if (descendant.status !== "open" || descendant.worktreeDir || descendant.placement) {
        throw new TaskGraphRefusal(
          `Refused: its child ${keyOrId(descendant)} is ${descendant.placement ? "committed to a computer" : descendant.status === "open" ? "bound to a workspace" : descendant.status}, so the subtree cannot move to another project.`,
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
      if (!opensPullRequest(deliveryForRecord(row, "local-only"))) continue;
      const name = repo?.name ?? project.name;
      const handle = keyOrId(row);
      throw new TaskGraphRefusal(
        `Refused: ${handle} asks to ship as a pull request (direct-pr), and ${name} has no remote to open one on, so ${handle} cannot move there. Configure a remote for ${name}, or set ${handle}'s delivery to local-only first.`,
      );
    }
    for (const { row, repoId: to } of moves) {
      const { seq, key } = this.projects.allocateSeq(project.id);
      this.writer.patch(row.id, { projectId: project.id, key, seq, repoId: to, updatedAt: at });
      this.writer.addEvent({
        taskId: row.id,
        at,
        actor,
        kind: "moved",
        text: `moved to ${project.name} as ${key} (was ${keyOrId(row)})`,
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
    this.writer.references.set(task.id, {
      kind,
      ref,
      targetId: target?.id ?? null,
      actor,
      recordedAt: at,
    });
    this.writer.touch(task.id);
  }
}
