import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import type { FolderNoticed, FolderRefreshRefusal } from "@shared/folderRefresh";
import type { MergeReview } from "@shared/mergeReview";
import type { RepoDelivery } from "@shared/repos";
import type { Deliverable } from "@shared/routingPolicy";
import type { ServedWakeOrigin } from "@shared/servedFrame";
import type { ForgePull } from "../forge";
import type { EmittedCardInput } from "../session/tools";
import type { InboxStore } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskStore";
import type { SettleRefusal, TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { WorkspaceService } from "../workspace/workspaceService";
import type { AskEnding } from "./askEnding";
import type { MergeBoundary, MergeGuard, PrOutcome } from "./changeMerge";
import type { TypedWake } from "./wakes";

/**
 * A settle attempt's result: whether it happened, and the text to show,
 * with the facts a merge's own outcome carries (`PrOutcome`).
 * `contention` marks a refusal that is not a verdict on the operation at
 * all - another settle (or triage) already owns the task - so the caller
 * that actually ran reports its own outcome separately; a contention
 * refusal never raises its own failure card.
 */
export type SettleOutcome = Omit<PrOutcome, "signIn"> & {
  contention?: boolean;
  /** A structured close refusal (WI-12): its ways ride the wake and the tool result. */
  refusal?: SettleRefusal;
  /**
   * A sentence in the app's words that follows the outcome on the feed even
   * when a raw failure is said plainly: the task the host started for what
   * the settle left behind.
   */
  followup?: string;
  /** The merge went through and the task stays open (INF-2490, INF-2525). */
  continued?: boolean;
  /**
   * What on the task is still open after a merge that kept it open, as a
   * clause - a question, by its title, or another pull request (INF-2525) -
   * which its crewmate judges what to do about.
   */
  stillOpen?: string;
};

/**
 * The card calls settling makes. The card service answers them; settling
 * names them here, so no settle owner imports the card service.
 */
export type SettleCards = {
  get(id: string): Card | undefined;
  values(): IterableIterator<Card>;
  snapshot(): Card[];
  put(next: Card): void;
  reviseBody(id: string, body: string): void;
  raiseHostCard(
    card: Omit<Card, "author" | "priority" | "status" | "createdAt">,
    options?: { note?: boolean },
  ): void;
  withdrawHostCard(id: string, reason: string): void;
  addFirstmateCard(input: EmittedCardInput): string;
  closedByCaptain(taskId: string): Card[];
  openMergeAction(
    taskId: string,
  ): { cardId: string; cardTitle: string; actionId: string; label: string } | undefined;
  releaseNotes(taskId: string): void;
  retireTaskCards(taskId: string, reason: string, options?: { keepNotes?: boolean }): void;
  showHeld(taskId: string, revise: (body: string) => string): void;
  scheduleBroadcast(): void;
};

/**
 * What settling needs from the supervisor that composes it, shared by every
 * settle owner (`createSettleOwners`).
 */
export type SettleServiceHost = {
  /** The host's one clock (the ticker's). */
  now: () => number;
  tasks: TaskService;
  inbox: InboxStore;
  workspace: WorkspaceService;
  repos: RepoRegistry;
  cards: SettleCards;
  /** How each captain's message ends: where a close's outcome goes (INF-1610). */
  askEnding: AskEnding;
  /** A close moved a message's work: the first mate's check reads it when it can. */
  asksMoved?: () => void;
  /** The task's live crewmate turn state, when a runtime holds it. */
  runtimeState(taskId: string): "starting" | "streaming" | "idle" | undefined;
  /**
   * Stop the task's live crewmate - its turn aborted, its runtime gone - or
   * undefined when there is none.
   */
  stopRuntime(taskId: string): Promise<void> | undefined;
  /** Something reached the task's crewmate: the center's spark flies to it (INF-759). */
  announceReach?: (taskId: string) => void;
  killJobs?: (taskId: string) => void;
  hasRunningJobs?: (taskId: string) => boolean;
  /**
   * A task whose working copy is on a computer that runs work
   * (docs/helper.md, "Its working copies"): what it holds unmerged there,
   * null while nobody can tell, and its branch brought here before this
   * Mac's own git reads it, in the repository it answers.
   */
  placed?: {
    workStatus(taskId: string): Promise<{ dirty: boolean; unlandedCommits: number } | null>;
    bringBranchHome(taskId: string): Promise<string | undefined>;
  };
  /** The personal workspace's running dot ends with the task. */
  endLiveTask(taskId: string): void;
  validateLocalStory?: (taskId: string) => Promise<string>;
  mergePullRequest?: (
    taskId: string,
    guard?: MergeGuard,
    boundary?: MergeBoundary,
  ) => Promise<PrOutcome>;
  /**
   * Merge one stored review (FI3-1543): a continuing merge, so the task
   * stays open (INF-2490).
   */
  mergeReview?: (taskId: string, reviewId: string, guard?: MergeGuard) => Promise<PrOutcome>;
  /** The requested merge's outcome reaches its still-open crewmate, including a kept merge. */
  mergeContinued?: (taskId: string, review: MergeReview | undefined, result: SettleOutcome) => void;
  closePullRequest?: (taskId: string) => Promise<PrOutcome>;
  /** The pinned pull request by its number, for a kept approval's reconcile (FI3-304). */
  readPull?: (taskId: string, prNumber: number) => Promise<ForgePull | undefined>;
  /**
   * A kept approval read its undecided repair: the supervisor sees that one
   * independent assessment decides it (FI3-663) - commissioned once, ended
   * when it stopped or ran past its bound without answering.
   */
  assessRepair?: (taskId: string) => void;
  /**
   * A merge's project folder could not be brought up to date: the supervisor
   * files the task that does it, or updates the one standing (INF-549).
   */
  fileFolderRepair?: (
    merged: TaskRecord,
    refusal: FolderRefreshRefusal & { reach?: string },
  ) => { record: TaskRecord; filed: boolean } | undefined;
  /**
   * Work found the project's folder missing: the supervisor files the task
   * that brings it back, or names the one standing, and answers the words
   * refusing that work (INF-572).
   */
  folderMissing?: (repoId: string, noticed: FolderNoticed, by?: TaskRecord) => string;
  /**
   * An abandoned task's pull request could not be closed: the supervisor
   * files the task that closes it, or names the one standing (INF-549's
   * sibling).
   */
  filePullRepair?: (
    abandoned: TaskRecord,
    problem: string | undefined,
  ) => { record: TaskRecord; filed: boolean } | undefined;
  isPersonalTask(taskId: string): boolean;
  deliverableOf(record: TaskRecord): Deliverable;
  taskDelivery(taskId: string): RepoDelivery | undefined;
  taskAutonomy(taskId: string): boolean;
  resolveTaskRef(ref: string, param: string): TaskRecord;
  notifyOp(wake: TypedWake, origin: ServedWakeOrigin, ref?: string): void;
  pokeInbox(): void;
  /** Any close may release a queued row waiting on the task (R1). */
  sweepGates(now: number): Promise<unknown>;
  broadcastCrewCounts(): void;
  broadcastEvent: (event: FmEvent) => void;
};
