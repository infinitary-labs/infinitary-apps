import type { Card } from "@shared/cards";
import type { TaskCostView } from "@shared/costLimit";
import type { CrewPicture, CrewResultText, CrewTranscript } from "@shared/crewTranscript";
import type { FmEvent } from "@shared/events";
import type { ValidationEvidence } from "@shared/liveValidation";
import type { ModelChoice } from "@shared/modelChoice";
import type { ModelReason } from "@shared/modelReason";
import type { Slot } from "@shared/modelSlots";
import type { RepoDelivery } from "@shared/repos";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import type { PolicyRepo, TaskRunsOn } from "@shared/taskPolicies";
import type { TaskActionLine, TaskCardRow, TaskPlace, TaskView } from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import type { CoreEventSink } from "../events";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import type { ClosedTaskSearch, ClosedTaskSearchInput } from "../storage/taskSelection";
import type { TaskService } from "./taskService";
import type { TaskTimeline } from "./taskTimeline";
import type { TaskWaitFacts } from "./taskWaits";

/**
 * What the host hands the task protocol (`TaskProtocol`, `taskProtocol.ts`):
 * the task service it reads and listens on, the live host facts its views
 * read at each read, and the seams its pushes and events cross.
 */
export type TaskProtocolOptions = {
  tasks: TaskService;
  timeline?: Pick<TaskTimeline, "history">;
  validationEvidence?: (taskId: string, evidence: ValidationEvidence[]) => ValidationEvidence[];
  /** Repo facts the views denormalize; absent repos read as none. */
  repos: {
    get(
      id: string,
    ): ({ name: string; delivery: RepoDelivery; autonomy: boolean } & PolicyRepo) | undefined;
  };
  /** The open card stack: which decision card a task waits on. */
  cards: {
    listOpen(): Card[];
    answerNoteForTask?(taskId: string): Card | undefined;
    snapshot(): Card[];
    /** Every card a task showed, newest first (the record's Cards row); `extraIds` are ones its timeline names. */
    forTask?(taskId: string, extraIds: readonly string[]): TaskCardRow[];
  };
  /** Live host presentation, independent of the persisted turn activity. */
  workPosture?: (record: TaskRecord) => WorkPosture;
  /** Shared posture-owner facts, not another per-row owner lookup. */
  waitFacts?: (record: TaskRecord) => TaskWaitFacts;
  /** The task's own browser on this Mac, as the captain reads it (docs/task-browser.md). */
  browser?: (taskId: string) => TaskBrowserFact | undefined;
  /**
   * What the task's crewmate did, oldest first, read from its kept session
   * at each read (`CrewActions`; docs/task-record.md, "A crewmate's actions").
   */
  actions?: (record: TaskRecord) => readonly TaskActionLine[];
  /** The last sentence the task's crewmate wrote, read the same way (`CrewActions.said`). */
  said?: (record: TaskRecord) => TaskActionLine | null;
  /**
   * The crewmate's sessions as its Crewmate tab reads them, at each read
   * (`CrewTranscripts`; docs/task-card-tabs.md, "The Crewmate tab").
   */
  transcript?: {
    of(record: TaskRecord, events: readonly TaskEvent[], closed: boolean): CrewTranscript;
    result(record: TaskRecord, ref: string): CrewResultText | null;
    picture(record: TaskRecord, ref: string): CrewPicture | null;
  };
  /** Deliver the focusable stack before any board shortcuts to it. */
  beforePush?: () => void;
  /** Mark and time each board push for the freeze recorder (`PassSteps.run`). */
  step?: <T>(name: string, run: () => T) => T;
  /**
   * The slot each work task's crewmate is served on (`TaskView.tier`),
   * read for the rows a view shows; absent means every tier reads null.
   */
  tiers?: (taskIds: readonly string[]) => ReadonlyMap<string, Slot>;
  /**
   * Find the closed work a typed search names (`search`) in the read-only
   * record process, off the main thread (docs/task-record.md); absent, the
   * task service reads the same selection in this process.
   */
  searchClosed?: (input: ClosedTaskSearchInput) => Promise<ClosedTaskSearch>;
  /**
   * A model (`provider/id`) by the name the captain knows it ("GPT-6 Sol"),
   * through the one model-name lookup (`ModelSlots.nameOf`); the record
   * falls back to the bare id.
   */
  modelLabel?: (model: string) => string | undefined;
  /** Why a task's crewmate runs on its model (`TaskDetail.modelReason`); absent when unknown. */
  modelReason?: (record: TaskRecord) => ModelReason | undefined;
  /** How it got that model (`TaskDetail.modelChoice`); absent when the decision saved no comparison. */
  modelChoice?: (record: TaskRecord) => ModelChoice | undefined;
  /** Live family spend through the cost-limit owner. */
  cost?: (record: TaskRecord) => TaskCostView | undefined;
  /** Where a task runs (`TaskDetail.runsOn`); absent when no other computer could run it. */
  runsOn?: (record: TaskRecord) => TaskRunsOn | undefined;
  /**
   * Where a task runs in words, and whether that computer is out of reach
   * (`TaskView.place`); absent for a task this Mac runs.
   */
  place?: (record: TaskRecord) => TaskPlace | undefined;
  /**
   * Whether started work may move to another computer, and the move that
   * stands (`TaskView.movable`, `TaskView.computerMove`; docs/helper.md,
   * "Moving a started task").
   */
  computerMove?: (record: TaskRecord) => Pick<TaskView, "movable" | "computerMove">;
  /** An accepted start the board should show before the row is claimed. */
  startAttempt?: (taskId: string) => { phase: "preparing" | "checking"; since: number } | undefined;
  /** The event seam every FmEvent crosses (feed persistence, Observe, clients). */
  broadcastEvent: (event: FmEvent) => void;
  /** The push seam for the board snapshot. */
  emit: CoreEventSink;
  now?: () => number;
  coalesceMs?: number;
  /** The live-set size above which pushes are deltas; the design's trigger by default. */
  deltaTrigger?: { rows: number; bytes: number };
  /**
   * Runs a part of a board pushed from nothing on the main thread's next
   * turn (`setImmediate` by default) and answers how to call it off.
   */
  nextTurn?: (run: () => void) => () => void;
};
