import type { TaskLifecycleOp } from "@shared/cards";
import type { ChangeRecord } from "@shared/change";
import type { OverridableHold } from "@shared/holds";
import type { ReasoningChoice } from "@shared/modelSlots";
import type { PlacementRequirements } from "@shared/placement";
import { TASK_CARD_VIA } from "@shared/provenance";
import { DROP_BEFORE_START } from "@shared/recordDrop";
import type { RepoView } from "@shared/repos";
import type { WorkShape } from "@shared/routingPolicy";
import type {
  ProjectTagChange,
  ProjectTagChangeResult,
  TagSetter,
  TaskTagView,
} from "@shared/tags";
import { pinActivity, pinMissingRefusal } from "@shared/taskPin";
import type { PlanItem } from "@shared/taskPlan";
import {
  type EffectiveTaskPolicies,
  effectiveTaskPolicies,
  type PolicyRepo,
  type TaskPolicyEdits,
} from "@shared/taskPolicies";
import { QUEUE_POLICY } from "@shared/taskQueue";
import type { DropEffects } from "@shared/tasks";
import { savedTaskTitle } from "@shared/taskTitle";
import { THROUGH_THE_COMMAND, type Through } from "@shared/through";
import type { RepetitionNotice, ToolObservation } from "@shared/toolCompletion";
import type { BriefPart, SpawnIntent } from "../orchestrator/intentBrief";
import { isHostRaisedShape } from "../storage/changeStore";
import type { AppDatabase } from "../storage/db";
import type { ProjectRecord, ProjectStore } from "../storage/projectStore";
import type {
  ConcernedTaskEvent,
  TaskConcern,
  TaskEvent,
  TaskEventActor,
} from "../storage/taskEventStore";
import type {
  PartCounts,
  TaskActivity,
  TaskClosedReason,
  TaskDelivery,
  TaskGate,
  TaskKind,
  TaskRecord,
  TaskRetentionFields,
  TaskStartPolicy,
  TaskStatus,
} from "../storage/taskRecords";
import {
  REFERENCE_SHAPE_FIELDS,
  TASK_REFERENCE_KINDS,
  type TaskReferenceKind,
} from "../storage/taskReferenceStore";
import { TaskRepetitionStore } from "../storage/taskRepetitionStore";
import {
  type ClosedTaskSearch,
  type ClosedTaskSearchInput,
  selectClosedTasks,
  selectTasks,
  type TaskSelectionInput,
} from "../storage/taskSelection";
import { compactBrief, expandBrief, reportHash } from "./briefReceipt";
import { admitUnderParent, type ContainerLoop, reopenHeldContainers } from "./containerParents";
import {
  joinWithRepositories,
  moveIntoProject,
  type ProjectMoveContext,
  tasksJoining,
} from "./projectMove";
import { latestResultOf, type ReportEntry, reportEntryOf, type TaskResult } from "./reportEntry";
import {
  moveWithinProject,
  type ProjectRepositoryRef,
  refuseRepositoryMove,
  repositoryInProject,
  repositoryName,
  restartInRepository,
} from "./repositoryMove";
import { TaskArchive } from "./taskArchive";
import { TaskCapture } from "./taskCapture";
import { CLOSE_EVENT_KIND } from "./taskCloses";
import { TaskDeliveries } from "./taskDeliveries";
import { recordReference, updateTaskFields } from "./taskFieldEdits";
import { TaskGraph, TaskGraphRefusal } from "./taskGraph";
import { TaskPlacement } from "./taskPlacement";
import { TaskStarts } from "./taskStarts";
import {
  changeProjectTags,
  judgeTaskTags,
  replaceTaskTags,
  setTaskTags,
  type TagJudgment,
  type TagsSet,
  tagIdsByName,
} from "./taskTags";
import { TaskTurns } from "./taskTurns";
import { keyOrId, type TaskChangeListener, TaskWriter } from "./taskWriter";
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
  /** With `project`: the repository it moves into, by name or id (`moveTargetRepository`). */
  repository?: string;
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
  /** The branch name unstarted work's branch starts with, already checked; empty clears it. */
  branch?: string;
  /**
   * The blocked_by task whose approved merge starts unstarted work
   * (docs/task-graph.md, "A part that starts at approval"), by id or key;
   * empty clears it.
   */
  startAtApproval?: string;
  /** The blocked_by tasks whose merge it needs, before it starts; empty clears it. */
  needsMerge?: string[];
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
export type TaskCardClick = {
  taskId: string;
  at: number;
  /** A lifecycle button, or the record's Close as done (INF-3169's plan, piece 3). */
  op: TaskLifecycleOp | "close-done";
  panel?: string;
  /** The click came from the captain's own command, `infinitary-axi` (INF-3898 piece 2). */
  through?: Through;
};

/**
 * Which button a task card history entry records, read from its typed kind:
 * the steer is Continue, the close of started work is Drop task on it (a
 * cancel request recorded before the one drop is too), the drop before
 * start is the footer's own drop, the start is Start, a start policy the
 * captain set is the task board's queue or unqueue, and a close as done is
 * the record's Close as done.
 */
function taskCardOp(event: TaskEvent): TaskCardClick["op"] | undefined {
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
      if (data.status === "done") return "close-done";
      // Drop task closes the record by the one drop: before the work
      // started it is the footer's own drop, after it the stop.
      if (data[DROP_BEFORE_START] === true) return "drop-task";
      return data.status === "dropped" ? "stop-task" : "start-task";
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
  /** The shape it is filed with, such as a reader's Build row's (docs/agents-reach.md, "A reader's Build rows"); absent, it is sorted when it starts. */
  shape?: WorkShape;
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
  private readonly moves: ProjectMoveContext;

  constructor(private readonly options: TaskServiceOptions) {
    this.writer = new TaskWriter(options);
    this.projects = this.writer.projects;
    this.graph = new TaskGraph(this.writer, this);
    this.moves = { writer: this.writer, graph: this.graph, repos: options.repos };
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

  /** The rows with these keys, in one read of the key index. */
  getManyByKey(keys: readonly string[]): TaskRecord[] {
    return this.writer.store.getManyByKey(keys);
  }

  select(input: TaskSelectionInput) {
    return selectTasks(this.options.db, input);
  }

  list(): TaskRecord[] {
    return this.writer.store.list();
  }

  /** Every row's id and status, without composing a record. */
  statuses(): Map<string, TaskStatus> {
    return this.writer.store.statuses();
  }

  /** Every row whose working copy the record still counts as present, live or closed, oldest first. */
  withPresentWorkspace(): TaskRecord[] {
    return this.writer.store.withPresentWorkspace();
  }

  /**
   * Containers closed while a part under them is live open again
   * (`containerParents.ts`), except one a live part waits on, directly or
   * through other tasks: opened, it would wait on its own part (INF-3846).
   */
  reopenHeldContainers(): string[] {
    return reopenHeldContainers(this.writer, this.containerLoop);
  }

  /** A container read as open: the wait loop through one of its live parts, in words (`ContainerLoop`). */
  private readonly containerLoop: ContainerLoop = (parent) => {
    const live = (task: TaskRecord) => task.id === parent || TaskService.blockerHoldsClose(task);
    for (const part of this.writer.store.listLiveChildren(parent)) {
      const cycle = liveWaitCycle(this, parent, part.id, live);
      if (cycle) return waitCycleWords(this, cycle);
    }
    return undefined;
  };

  /** Rows waiting to start (the old queued set, every kind). */
  listOpen(): TaskRecord[] {
    return this.writer.store.listByStatus("open");
  }

  /** Rows a crewmate holds or held and left resumable. */
  listActive(): TaskRecord[] {
    return this.writer.store.listByStatus("active");
  }

  listLive(): TaskRecord[] {
    return this.writer.store.listByStatus("open", "active");
  }

  /** Unacknowledged external eligibility removals, including tasks that already closed. */
  pendingQueueRemovals(): TaskRecord[] {
    return this.writer.store.pendingQueueRemovals();
  }

  /** Approval records holding a merge whose outcome was never read back, including tasks that already closed. */
  unresolvedMergeSends(): TaskRecord[] {
    return this.writer.store.unresolvedMergeSends();
  }

  /** How many active rows each computer that runs work holds, by its id, counted without composing task records. */
  activeCountsByDevice(): Map<string, number> {
    return this.writer.store.countActiveByDevice();
  }

  /** How many active independent reviews each computer holds, counted without composing task records. */
  activeReviewCountsByDevice(): Map<string, number> {
    return this.writer.store.countActiveReviewsByDevice();
  }

  /** Recorded overrides standing on this computer, read without composing task records. */
  passingOverridesForComputer(computerId: string, kind: OverridableHold): string[] {
    return this.writer.store.passingOverridesForComputer(computerId, kind);
  }

  /** Every row holding a computer move, open or closed, oldest first, read without the rest. */
  listWithComputerMove(): TaskRecord[] {
    return this.writer.store.listWithComputerMove();
  }

  /** The rows holding a requirement from this source task or for one of these shared actions. */
  listWithRequirementFrom(source: string, sharedIds: readonly string[]): TaskRecord[] {
    return this.writer.store.listWithRequirementFrom(source, sharedIds);
  }

  /** The live set and every row closed at or after `since`, oldest first. */
  listLiveOrClosedSince(since: number): TaskRecord[] {
    return this.writer.store.listLiveOrClosedSince(since);
  }

  /** Every pinned row, whatever its state or age, oldest first (INF-3127). */
  listPinned(): TaskRecord[] {
    return this.writer.store.listPinned();
  }

  /**
   * The window's search of earlier work in this process, for a host with no
   * record process (`TaskProtocol.search`); it returns only the matches' ids.
   */
  searchClosed(input: ClosedTaskSearchInput): ClosedTaskSearch {
    return selectClosedTasks(this.options.db, input);
  }

  /** Each closed row's retention fields with its close in `[from, upTo]`, without composing it. */
  listClosedRetentionFields(from: number | null, upTo: number | null): TaskRetentionFields[] {
    return this.writer.store.listClosedRetentionFields(from, upTo);
  }

  /** These tasks' retention fields, those that still exist, without composing them. */
  retentionFields(ids: readonly string[]): TaskRetentionFields[] {
    return this.writer.store.retentionFields(ids);
  }

  /** The ids of every task live work builds on, the live set included, read in one statement (INF-3641). */
  heldByLiveWork(): Set<string> {
    return this.writer.store.heldByLiveWork();
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
  childCounts(parentIds: readonly string[]): Map<string, PartCounts> {
    return this.writer.store.childCounts(parentIds);
  }

  timeline(id: string): TaskEvent[] {
    return this.writer.events.listFor(id);
  }

  /** Whether one of the task's notes holds `value` under `key` in its data, decoding none of its history. */
  hasNoteWith(id: string, key: string, value: string | number): boolean {
    return this.writer.events.hasNoteWith(id, key, value);
  }

  /** Recorded unresolved leftovers, seeking only this computer's close reports. */
  leftoverNotes(computerId: string | null): TaskEvent[] {
    return this.writer.events.leftoverNotes(computerId);
  }

  /** Marks a close report resolved: later pressure notices stop naming it (docs/leftover-programs.md). */
  resolveLeftoverNote(eventId: number): void {
    this.writer.events.resolveLeftovers(eventId);
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
        const through = event.data?.through === THROUGH_THE_COMMAND;
        return op
          ? [
              {
                taskId: event.taskId,
                at: event.at,
                op,
                ...(panel ? { panel } : {}),
                ...(through ? { through: THROUGH_THE_COMMAND } : {}),
              },
            ]
          : [];
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

  isClosed(record: Pick<TaskRecord, "status">): boolean {
    return TaskService.isClosed(record);
  }

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
        // The last guard (docs/task-record.md, "A task's title"): a title
        // past its room that reaches the row is the host's own.
        title: savedTaskTitle(input.title),
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
        recordReference(this.writer, record, kind, ref, target, actor, at);
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
      // A closed container opens before the waits go in, so the link writer
      // reads it live and refuses a part that waits on it (INF-3846).
      if (parent && !TaskService.isClosed(record))
        admitUnderParent(this.writer, parent, key, actor, at, this.containerLoop);
      for (const blockerId of input.blockedBy ?? []) {
        this.graph.insertLink(blockerId, record.id, "blocks", actor, at);
      }
      return record;
    });
    return run();
  }

  /** A task's policies now, read with its project's settings; none for a missing record. */
  policiesOf(record: TaskRecord | undefined): EffectiveTaskPolicies | null {
    if (!record) return null;
    return effectiveTaskPolicies(
      record,
      record.repoId ? this.options.repos?.get(record.repoId) : undefined,
    );
  }

  /** Edit the plain fields of a record; one `note` event lists what changed (taskFieldEdits.ts). */
  updateFields(id: string, patch: UpdateTaskPatch, actor: TaskEventActor): string[] {
    return updateTaskFields(
      { writer: this.writer, projects: this.projects, service: this },
      id,
      patch,
      actor,
    );
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
      // A closed container opens first, so the check below reads it live; a
      // refusal rolls the opening back with the rest of this write (INF-3846).
      if (!TaskService.isClosed(record))
        admitUnderParent(this.writer, parent, keyOrId(record), actor, at, this.containerLoop);
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
        moveIntoProject(this.moves, record, parent.projectId, actor, at, parent.repoId);
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
   * except a part bound to a repository of its own (`moveIntoProject`).
   */
  moveToProject(
    id: string,
    projectId: string,
    actor: TaskEventActor,
    repository?: string,
  ): TaskRecord {
    const at = this.writer.now();
    const run = this.writer.write((): TaskRecord => {
      const record = this.writer.mustGet(id);
      if (record.projectId !== projectId)
        moveIntoProject(this.moves, record, projectId, actor, at, undefined, repository);
      return this.writer.mustGet(id);
    });
    return run();
  }

  /**
   * Move open work that has not started to another repository of its own
   * project, by name or id, keeping its key (`moveWithinProject`). Answers
   * the repository's name, or undefined when it already works there.
   */
  moveWithinProject(id: string, repository: string, actor: TaskEventActor): string | undefined {
    const at = this.writer.now();
    return this.writer.write((): string | undefined => {
      const record = this.writer.mustGet(id);
      const target = repositoryInProject(this.moves, record, repository);
      return moveWithinProject(this.moves, record, target, actor, at) ? target.name : undefined;
    })();
  }

  /**
   * Started work with no commits of its own starts again in another
   * repository of its project (`restartInRepository`), once the caller has
   * stopped its crewmate and removed its empty working copy.
   */
  restartInRepository(id: string, target: ProjectRepositoryRef, actor: TaskEventActor): void {
    const at = this.writer.now();
    this.writer.write(() => {
      restartInRepository(this.moves, this.writer.mustGet(id), target, actor, at);
    })();
  }

  /**
   * Why started work cannot start again in `target` (`refuseRepositoryMove`),
   * read before its crewmate stops; undefined when nothing refuses it.
   */
  repositoryMoveRefusal(id: string, target: ProjectRepositoryRef): string | undefined {
    const record = this.writer.mustGet(id);
    const projectName = this.writer.projects.get(record.projectId)?.name ?? target.name;
    try {
      refuseRepositoryMove(this.moves, [{ row: record, repoId: target.id }], projectName);
      return undefined;
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return caught.message;
      throw caught;
    }
  }

  /** The repository of the task's own project `named` names (`repositoryInProject`). */
  repositoryInProject(id: string, named: string): ProjectRepositoryRef {
    return repositoryInProject(this.moves, this.writer.mustGet(id), named);
  }

  /** The name of the task's own repository, when its project holds it. */
  repositoryNameOf(record: Pick<TaskRecord, "projectId" | "repoId">): string | undefined {
    return repositoryName(this.moves, record.projectId, record.repoId);
  }

  /** The tasks a move of repositories would take along (INF-5005), oldest first; nothing is written. */
  tasksJoining(move: Parameters<typeof tasksJoining>[1]): TaskRecord[] {
    return [...tasksJoining(this.writer.store, move).values()];
  }

  /**
   * Repositories join another project with their tasks, keys kept
   * (INF-5005, `joinWithRepositories`): `rows` writes the repositories'
   * move and answers the project they joined, in the same write, so a
   * refusal changes nothing. The board reads its projects again.
   */
  joinWithRepositories(
    move: Omit<Parameters<typeof joinWithRepositories>[1], "to">,
    actor: TaskEventActor,
    rows: () => Pick<ProjectRecord, "id" | "name">,
  ): number {
    const at = this.writer.now();
    return this.writer.write(() => {
      const moved = joinWithRepositories(this.writer, { ...move, to: rows() }, actor, at);
      this.writer.pending.presentation = true;
      return moved;
    })();
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
        ...(input.shape ? { shape: input.shape } : {}),
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
   * Pin a task to the top of Tasks, or unpin it (INF-3127): a dated fact on
   * its own record, whatever its state, with one quiet line on its timeline
   * and no feed line. It writes nothing else: no priority, order, start
   * policy, project or parent, and no crewmate is told. Pinning a pinned
   * task, or unpinning one that is not, changes nothing.
   */
  setPinned(
    id: string,
    pinned: boolean,
    input: { actor: "captain" | "firstmate"; panel?: string | undefined },
  ): { ok: true; changed: boolean } | { ok: false; text: string } {
    const run = this.writer.write(
      (): { ok: true; changed: boolean } | { ok: false; text: string } => {
        const record = this.writer.store.get(id);
        if (!record) return { ok: false, text: pinMissingRefusal(id) };
        if ((record.pinnedAt != null) === pinned) return { ok: true, changed: false };
        const at = this.writer.now();
        this.writer.patch(id, { pinnedAt: pinned ? at : null, updatedAt: at });
        this.writer.addEvent({
          taskId: id,
          at,
          actor: input.actor,
          kind: "note",
          text: pinActivity(input.actor, pinned),
          data: {
            pin: pinned ? "pinned" : "unpinned",
            ...(input.panel ? { panel: input.panel } : {}),
          },
          feed: false,
        });
        return { ok: true, changed: true };
      },
    );
    return run();
  }

  /** The tags a task carries, alphabetical, each with who set it (docs/task-tags.md). */
  tagsOf(id: string): TaskTagView[] {
    return this.writer.store.tags.viewsOf(id);
  }

  /** Turn tags on or off on a task, with one quiet timeline line (`setTaskTags`). */
  setTags(id: string, wanted: readonly { tagId: string; on: boolean }[], by: TagSetter): TagsSet {
    return setTaskTags(this.writer, id, wanted, by);
  }

  /** The decision model's answers on a task, kept with the revision each read (`judgeTaskTags`). */
  judgeTags(id: string, judgments: readonly TagJudgment[]): TagsSet & { kept: number } {
    return judgeTaskTags(this.writer, id, judgments);
  }

  /** A task's tags become exactly these, by id or, from the first mate's tools, by name. */
  replaceTags(
    id: string,
    tags: { ids: readonly string[] } | { names: readonly string[] },
    by: Exclude<TagSetter, "decision">,
  ): TagsSet {
    const ids = "ids" in tags ? tags.ids : tagIdsByName(this.writer, id, tags.names);
    return replaceTaskTags(this.writer, id, ids, by);
  }

  /** Add, edit or remove one of a project's tags (`changeProjectTags`). */
  changeProjectTags(change: ProjectTagChange): ProjectTagChangeResult {
    const done = changeProjectTags(this.writer, change);
    // A project's tags ride its view, which no task row carries.
    this.invalidatePresentation();
    return { ...done, tags: this.projects.tags.views().get(done.projectId) ?? [] };
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
      // A closed task never runs, so the room its start set aside ends with
      // it, whatever its preparation reached: nothing else may ever free it
      // (INF-3366).
      if (record.placement)
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
        this.delivery.activateAfterMergeSteps(id, input.actor);
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
}
