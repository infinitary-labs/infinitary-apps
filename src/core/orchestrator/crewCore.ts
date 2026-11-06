import type { TurnImage } from "@shared/cards";
import type { ServedWakeOrigin } from "@shared/servedFrame";
import type { CrewPrograms, ProgramRunner } from "../program/programRunner";
import type { ModelSession } from "../session/session";
import type { InboxRow } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskStore";
import type { CardService } from "./cardService";
import type { CrewBrief } from "./crewBrief";
import type { PlacementRecord, TaskRuntime } from "./crewRuntime";
import type { CrewmateSpec } from "./crewSession";
import type { CrewSessions } from "./crewSessions";
import type { CrewSteer } from "./crewSteer";
import type {
  CrewSupervisorOptions,
  FirstmateHooks,
  PersonalLiveDelegate,
} from "./crewSupervisorOptions";
import type { CrewTurns } from "./crewTurns";
import type { CrewUpdates } from "./crewUpdates";
import type { AccountServeability, IdleLadder, RunningJob } from "./idleLadder";
import type { ReportIntake } from "./reportIntake";
import type { WakeOpenReview } from "./reportWakes";
import type { RestartWatch } from "./restartWatch";
import type { Reviews } from "./reviews";
import type { SettleOwners } from "./settleOwners";
import type { TaskMoves } from "./taskMoves";
import type { TaskPlacement } from "./taskPlacement";
import type { TypedWake } from "./wakes";

/**
 * What the crew supervisor's core owners share (docs/architecture.md
 * section 2): the crew's sessions (`CrewSessions`), its turns (`CrewTurns`)
 * and its steering (`CrewSteer`) each hold this one typed view of the
 * supervisor, and reach the others and the leaf owners through it. The
 * supervisor builds it once, after every owner it names exists; the facts
 * it reads through a function are the supervisor's own until they move.
 */
export type CrewCore = {
  readonly options: CrewSupervisorOptions;
  /** The crewmate running each task here now, by task. */
  readonly tasks: Map<string, TaskRuntime>;
  now(): number;
  /** The app is quitting: a turn that settles now is not the crew's to act on. */
  disposed(): boolean;
  /** What the first mate's side asked to hear (`CrewSupervisor.setFirstmateHooks`). */
  hooks(): FirstmateHooks;

  readonly sessions: CrewSessions;
  readonly turns: CrewTurns;
  readonly steer: CrewSteer;

  readonly briefs: CrewBrief;
  readonly cards: CardService;
  readonly crewPrograms: CrewPrograms;
  readonly ladder: IdleLadder;
  readonly moves: TaskMoves;
  readonly placement: TaskPlacement;
  readonly programs: ProgramRunner;
  readonly reportIntake: ReportIntake;
  readonly restarts: RestartWatch;
  readonly reviews: Reviews;
  readonly settling: SettleOwners;
  readonly updates: CrewUpdates;

  /** Tell the window the crew's counts changed. */
  broadcastCrewCounts(): void;
  /** Whether a task's events skip supervision: a review task itself. */
  bypassesSupervision(taskId: string): boolean;
  /** When work the crewmate's client started on its own began running, if it still runs. */
  clientJobStart(taskId: string): number | undefined;
  /** What a crewmate's tools run on: this task's callbacks into the host. */
  crewmateHooks(
    task: TaskRuntime,
    personal: PersonalLiveDelegate | undefined,
  ): Omit<CrewmateSpec, "taskId" | "machineId" | "cwd">;
  /** A task lane's due rows. */
  deliverableRows(taskId: string, now: number): InboxRow[];
  /** Follow a crewmate's session events: they are its task's activity and reach the feed. */
  follow(task: TaskRuntime, session: ModelSession): Promise<() => Promise<void>>;
  /** A started task went back to the backlog: the host's own rows wait on its lane until a Start. */
  inBacklog(taskId: string): boolean;
  /** A task on the personal workspace: no worktree, the host commits, a report closes it. */
  isPersonalTask(taskId: string): boolean;
  /** A task lane is held: a move under way, or a typed cut-off on its account (docs/inbox.md). */
  laneHeld(taskId: string): boolean;
  /** Where a task's crewmate runs: the computer that runs work its record names, or this Mac. */
  machineOf(taskId: string): string;
  /** The host's longest-running job, or the client's work when it has no job list. */
  oldestJob(taskId: string): RunningJob | undefined;
  /** The task runs on a computer that runs work, out of reach or back and not yet caught up. */
  outOfReach(taskId: string): boolean;
  /** Guidance that never became a turn: kept on the task's timeline and said in the feed. */
  recordUndeliveredGuidance(
    taskId: string,
    title: string | undefined,
    why: string,
    rows: InboxRow[],
  ): void;
  /** Refresh only between review turns; never move a checkout under a running reviewer. */
  refreshReview(task: TaskRuntime): Promise<string | undefined>;
  /** A stall card's effect that could not run: one feed line, as a card choice's does. */
  reportCardEffectFailure(taskId: string | undefined, caught: unknown): void;
  /** The builder a review task reads: its parent, the one stored join. */
  reviewBuilderOf(record: PlacementRecord | undefined): TaskRecord | undefined;
  /** A builder's open review whose last verdict was findings or blocked, while no cap holds its re-reviews. */
  reviewToReread(builder: TaskRecord): WakeOpenReview | undefined;
  /** The one router for crew lifecycle events. */
  routeCrewEvent(taskId: string, wake: TypedWake, origin: ServedWakeOrigin): number | null | void;
  /** The pictures the rows' messages keep copies of; a missing or changed copy blocks the rows. */
  rowPictures(taskId: string, rows: readonly InboxRow[]): { images?: TurnImage[]; blocked?: true };
  /** Whether each account serves, as the cut-off contract reads it; absent when neither is given. */
  serveability(): AccountServeability | undefined;
  /** The ready sweep over open and active rows (docs/task-graph.md). */
  sweepGates(now: number): Promise<void>;
};
