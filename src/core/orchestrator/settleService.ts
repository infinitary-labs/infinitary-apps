import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type Card, settleEffectOf } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import type { FmEvent } from "@shared/events";
import type { FolderNoticed, FolderRefreshRefusal } from "@shared/folderRefresh";
import { forgePlace, hasChangeRequests } from "@shared/forge";
import { fixedHoldWords, overridePasses, softHoldWords, withoutHoldWords } from "@shared/holds";
import { acceptedValidation } from "@shared/liveValidation";
import type { MergeRelationship, MergeReview } from "@shared/mergeReview";
import { plainProblem, type TypedFailure } from "@shared/plainProblem";
import type { RepoDelivery } from "@shared/repos";
import { type Deliverable, isFolderWork } from "@shared/routingPolicy";
import type { ServedWakeOrigin } from "@shared/servedFrame";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import type { TaskDeliveryMode } from "@shared/tasks";
import { MERGE_WORDS } from "@shared/vocabulary";
import { type ForgePull, forgeLocationOf, signInRefusal } from "../forge";
import { CAREFUL_LIVE_VALIDATION } from "../prompts/liveValidation";
import { FIRSTMATE_RECIPIENT, type InboxStore } from "../storage/inboxStore";
import {
  type MergeAuthorization,
  type MergeWait,
  type PendingSettleIntent,
  standingCap,
  type TaskRecord,
} from "../storage/taskStore";
import { type SettleRefusal, type SettleWay, TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import {
  keptWorkWords,
  type TaskWorkspace,
  type WorkspaceService,
} from "../workspace/workspaceService";
import { type CardService, cardEmitter } from "./cardService";
import { escapeCardText } from "./cardText";
import {
  approvableOffer,
  candidateHead,
  keptFeedLine,
  keptNote,
  mergeHold,
  outstandingGuidance,
  retryAfter,
  standingAuthorization,
  wakesFirstmate,
} from "./mergeAuthorization";
import type { MergeGuard, MergeStop, PrOutcome } from "./prCi";
import { reviewCoversHead } from "./reviewCarry";
import {
  cannotMergeText,
  closedWithoutClick,
  closingNoteTitle,
  discardedText,
  folderNotUpdatedText,
  hasMergeLine,
  mergedLine,
  pullLeftOpenText,
  unlandedWorkText,
  withMergeLine,
} from "./settleWords";
import type { AnswerTaskClosedPayload, TypedWake } from "./wakes";

/**
 * Settling and closing a task (the primitives review's P4 and P6,
 * docs/task-record.md, docs/delivery-rigor.md): the one place a
 * crewmate's work goes in (land, merge-pr), is thrown away (discard), or a
 * task otherwise closes - its record, its lane and queued wakes in one
 * transaction (`closeAndPurge`), its cards off the stack, its worktree
 * retired with unlanded work saved first, and its delivery children after
 * it.
 *
 * - One settle owns a task at a time, across cards, the shell and the
 *   Firstmate's tools; a merge or land the captain asked for mid-turn is a
 *   durable intent that waits for the turn's boundary.
 * - Every refusal is structured (WI-12): the close gate, unlanded work, the
 *   autonomy hold and a missing sign-in carry their ways out.
 * - A settle the captain triggered always wakes the Firstmate with its
 *   outcome; a Firstmate settle hears it as its tool result.
 *
 * The supervisor composes it and supplies the live runtimes and the task
 * facts it reads through `SettleServiceHost`.
 */

/**
 * A settle attempt's result: whether it happened, and the text to show.
 * `contention` marks a refusal that is not a verdict on the operation at
 * all - another settle (or triage) already owns the task - so the caller
 * that actually ran reports its own outcome separately; a contention
 * refusal never raises its own failure card.
 */
export type SettleOutcome = {
  ok: boolean;
  text: string;
  contention?: boolean;
  /** A structured close refusal (WI-12): its ways ride the wake and the tool result. */
  refusal?: SettleRefusal;
  /**
   * The raw failure `text` quotes (a git, gh or network error). The feed
   * says what it means through `plainProblem`; the raw words stay on the
   * task's timeline and in the Firstmate's wake.
   */
  problem?: string;
  /** The reason in the app's words, where `text` carries raw detail that is not a failure. */
  plain?: string;
  /** The merge was refused only because the checks had not all passed. */
  notGreen?: boolean;
  /** Why a merge under the captain's kept approval stopped (`MergeStop`). */
  stop?: MergeStop;
  /** The merge GitHub confirmed. */
  receipt?: PrOutcome["receipt"];
  /**
   * A sentence in the app's words that follows the outcome on the feed even
   * when a raw failure is said plainly: the task the host started for what
   * the settle left behind.
   */
  followup?: string;
};

/**
 * The captain's click on a completion offer, as the click handler read it
 * off the shown card: the card, its occurrence and version, the action and
 * the gesture's own id (FI3-304).
 */
export type MergeApproval = {
  cardId: string;
  lifecycleId?: string;
  offerId?: string;
  actionId: string;
  interactionId?: string;
};

/** What a stopped merge means for a kept approval: the wait it now stands on. */
function waitOf(result: SettleOutcome, undecided: boolean): MergeWait {
  switch (result.stop) {
    case "conflict":
    case "behind":
      return "conflict";
    case "moved":
      return undecided ? "evidence" : "repair";
    case "checks":
      return "checks";
    case "protected":
    case "computing":
    case "draft":
    case "sign-in":
    case "transient":
    case "outcome":
    case "guidance":
      return result.stop;
    default:
      if (result.refusal?.refused === "not-signed-in") return "sign-in";
      if (result.notGreen) return "checks";
      return "refused";
  }
}

/** A record's worktree facts in the shape the workspace service takes. */
function workspaceOf(record: TaskRecord): TaskWorkspace {
  return {
    taskId: record.id,
    cwd: record.worktreeDir,
    branch: record.branch,
    repoDir: record.repoDir,
  };
}

/**
 * The feed line for a settle the captain clicked. An outcome with no raw
 * failure is already written in the app's words and reads as-is; one that
 * quotes a git, gh or network error says what it means instead (the
 * vocabulary's error row, `plainProblem`), and the raw text stays on the
 * task's timeline.
 */
function settleFeedLine(
  title: string,
  mode: "merge-pr" | "land" | "discard",
  result: { ok: boolean; text: string; problem?: string; plain?: string; followup?: string },
): string {
  // A hold's sentence tells an agent how it passes; his line leaves it out.
  if (!result.problem && !result.plain) return withoutHoldWords(result.text);
  const plain = result.problem ? plainProblem(result.problem) : (result.plain as string);
  if (mode === "discard") {
    return result.ok
      ? `Discarded "${title}". Its pull request is still open where the project lives: ${plain}${result.followup ? `. ${result.followup}` : ""}`
      : `Could not discard "${title}": ${plain}`;
  }
  return cannotMergeText(title, plain);
}

/** The record's state in the words the tools and refusals use. */
export function describeStatus(record: TaskRecord): string {
  if (record.status === "open") return "queued";
  if (record.status === "active") return record.activity ?? "active";
  return record.closedReason ?? record.status;
}

/** How a task closes: its status and reason, who closed it, and what the close records. */
export type TaskClose = {
  status: "done" | "dropped";
  reason:
    | "landed"
    | "merged"
    | "released"
    | "answered"
    | "discarded"
    | "cancelled"
    | "finished"
    | "superseded";
  actor: "captain" | "firstmate" | "host";
  text?: string;
  /** Delivery facts learned by the close; a live close carries its posture. */
  delivery?: {
    mode?: TaskDeliveryMode;
    landedMode?: "fast-forward" | "merge" | "pr";
  };
  /** False when another row already carries this close's feed line. */
  feed?: boolean;
  /** A selected answer choice to queue after the close transaction commits. */
  answerHandoff?: AnswerTaskClosedPayload;
  /** Extra facts the close records on its timeline event. */
  data?: Record<string, unknown>;
};

/** A typed merge/discard completion offer (with the host's Review carefully), never an unrelated decision. */
export function isRoutineMergeCard(card: Card): boolean {
  return (
    card.author === "crewmate" &&
    card.actions.some((action) => settleEffectOf(action)?.mode === "merge") &&
    card.actions.every((action) => settleEffectOf(action) || action.care)
  );
}

/** What settling needs from the supervisor that composes it. */
export type SettleServiceHost = {
  /** The host's one clock (the ticker's). */
  now: () => number;
  tasks: TaskService;
  inbox: InboxStore;
  workspace: WorkspaceService;
  repos: RepoRegistry;
  cards: CardService;
  /** Check selected proof synchronously, preserving the final no-yield send boundary. */
  verifyValidationEvidence?: (taskId: string) => void;
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
  mergePullRequest?: (
    taskId: string,
    guard?: MergeGuard,
    boundary?: import("./prCi").MergeBoundary,
  ) => Promise<PrOutcome>;
  /**
   * Merge one stored review (FI3-1543). The caller closes an owned task;
   * a referenced merge leaves the task open.
   */
  mergeReview?: (
    taskId: string,
    reviewId: string,
    guard?: MergeGuard,
  ) => Promise<PrOutcome & { relationship?: MergeRelationship }>;
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

/**
 * A card that holds `settle_task answered`. A crewmate card still up is the
 * captain's to close. A Firstmate note stays through a done close, so it
 * does not hold it. A Firstmate card that still asks something would be
 * taken down by the close, so it holds it until he answers (FI3-1581).
 */
function holdsAnswerClose(entry: Card, taskId: string): boolean {
  if (entry.taskId !== taskId) return false;
  const emitter = cardEmitter(entry.id, taskId);
  if (emitter === "crewmate") return true;
  return emitter === "firstmate" && entry.actions.length > 0;
}

export class SettleService {
  /** Per-task exclusion, shared by card actions and conversational settles. */
  private readonly settlingTasks = new Map<string, string>();
  /** Durable settle intents waiting for the current crewmate turn to go idle. */
  private readonly settleBoundaryWaiters = new Map<string, Set<() => void>>();

  private readonly sentMerges = new Set<string>();
  private readonly retirements = new Map<string, Promise<"removed" | "kept" | "none">>();
  /**
   * The first mate's closing sentence for a task it is closing now
   * (INF-547): the one sentence the captain reads about started work that
   * closed without their click. Only the first mate's own close tools set
   * one, so a captain's click never carries it; the close that follows
   * takes it (`takeClosingSentence`).
   */
  private readonly closingSentences = new Map<string, string>();

  mergeWasSent(taskId: string): boolean {
    return this.sentMerges.has(taskId);
  }

  constructor(private readonly host: SettleServiceHost) {}

  /**
   * Runs one of the first mate's settles with its closing sentence, which
   * lasts only as long as that settle: the close it makes carries it.
   */
  async withClosingSentence<T>(
    taskId: string,
    sentence: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.closingSentences.set(taskId, sentence);
    try {
      return await run();
    } finally {
      this.closingSentences.delete(taskId);
    }
  }

  /**
   * The first mate cancelled this task: its close comes when the turn it
   * stopped ends (`closeRecord`), and carries the sentence then.
   */
  expectClosingSentence(taskId: string, sentence: string): void {
    this.closingSentences.set(taskId, sentence);
  }

  /** A cancel that will not close the task after all leaves no sentence behind. */
  forgetClosingSentence(taskId: string): void {
    this.closingSentences.delete(taskId);
  }

  /** The sentence a close takes; never a captain's, whose click carries none. */
  private takeClosingSentence(taskId: string, actor: TaskClose["actor"]): string | undefined {
    const sentence = this.closingSentences.get(taskId);
    if (sentence === undefined || actor === "captain") return undefined;
    this.closingSentences.delete(taskId);
    return sentence;
  }

  /**
   * The first mate's note on started work it closed (INF-547, the
   * captain's direction C with their answers): when the close leaves nothing
   * of the task on their stack - no crewmate's story, no other note - and
   * the captain has not already closed the crewmate's outcome card, its
   * sentence goes up as the first mate's own note on that task. A note
   * holds nothing and asks nothing; only their close takes it down.
   */
  private leaveClosingNote(
    record: TaskRecord,
    reason: TaskClose["reason"],
    sentence: string,
  ): void {
    const outcome = closedWithoutClick(reason);
    if (!outcome || record.startedAt === null) return;
    // Work the first mate marked its own at the start (INF-1467, the
    // captain's direction A): the captain did not ask for it, so only a
    // merge or a release - code reaching their project without their
    // click - puts a note up. A drop or a finish stays on the record and
    // in Activity.
    if (record.shape?.internal_step && outcome !== "merged" && outcome !== "released") return;
    // The captain closed the crewmate's own outcome card and its crewmate
    // reported the work finished: their close already said what became of
    // it, so a note would only say it twice (INF-1137).
    if (record.delivery?.finishedAt !== undefined) return;
    if ([...this.host.cards.values()].some((card) => card.taskId === record.id)) return;
    const closed = this.host.tasks.get(record.id) ?? record;
    const prUrl = closed.delivery?.prUrl;
    const prNumber = closed.delivery?.prNumber;
    const pullRequest =
      outcome === "merged" && prUrl && prNumber !== undefined
        ? `<p>Merged <a class="inf-mono" href="${escapeCardText(prUrl)}">PR #${prNumber}</a>.</p>`
        : "";
    this.host.cards.addFirstmateCard({
      title: closingNoteTitle(record.key || record.id, outcome),
      body: `<p>${escapeCardText(sentence)}</p>${pullRequest}`,
      actions: [],
      taskId: record.id,
    });
  }

  /**
   * The merge of a task that merges on its own, on its story note
   * (INF-1219, the captain's direction A): the line that said it merges on
   * its own is rewritten on the same note to say it merged, when, its pull
   * request and the first mate's closing sentence. The note stays up, so no
   * closing note of the first mate's goes up beside it.
   */
  private finishMergeNote(
    record: TaskRecord,
    actor: TaskClose["actor"],
    sentence: string | undefined,
  ): void {
    const note = [...this.host.cards.values()].find(
      (card) =>
        card.taskId === record.id &&
        card.author === "crewmate" &&
        card.actions.length === 0 &&
        hasMergeLine(card.body),
    );
    if (!note) return;
    const delivery = (this.host.tasks.get(record.id) ?? record).delivery;
    const label =
      delivery?.prNumber !== undefined
        ? `PR ${this.changeName(this.host.tasks.get(record.id) ?? record, delivery.prNumber)}`
        : delivery?.changeLabel;
    const line = mergedLine({
      at: this.host.now(),
      onItsOwn: actor !== "captain",
      ...(label ? { change: { label, ...(delivery?.prUrl ? { url: delivery.prUrl } : {}) } } : {}),
      ...(sentence ? { sentence } : {}),
    });
    this.host.cards.reviseBody(note.id, withMergeLine(note.body, line));
  }

  /** Where the task's project lives, in the person's words ("GitHub", "GitLab", a host's address). */
  private placeOf(record: TaskRecord | undefined): string {
    const repo = record?.repoId ? this.host.repos.get(record.repoId) : undefined;
    return (
      (repo?.host ? forgePlace({ kind: repo.host.kind, host: repo.host.name }) : null) ??
      "the project's host"
    );
  }

  /**
   * The task's pull request by its number, in the host's own words: the
   * label the forge recorded for it (`#N`, `!N`), else `#N`.
   */
  private changeName(record: TaskRecord | undefined, number: number): string {
    const delivery = record?.delivery;
    return delivery?.prNumber === number && delivery.changeLabel
      ? delivery.changeLabel
      : `#${number}`;
  }

  private policiesOf(record: TaskRecord) {
    return effectiveTaskPolicies(
      record,
      record.repoId ? this.host.repos.get(record.repoId) : undefined,
    );
  }

  /** Last synchronous check, after every asynchronous read and before each send. */
  private mergeBoundary(
    taskId: string,
    mode: "merge-pr" | "land",
    actor: "captain" | "firstmate",
    proceedWithOpen: boolean,
  ) {
    const initial = this.host.tasks.get(taskId);
    const signature = initial ? JSON.stringify(this.policiesOf(initial)) : "";
    return (head?: string): string | undefined => {
      const record = this.host.tasks.get(taskId);
      if (!record || TaskService.isClosed(record)) return "the task closed";
      if (signature !== JSON.stringify(this.policiesOf(record)))
        return "its policies changed; recheck the current requirements before trying again";
      if (this.working(taskId)) return "its crewmate is still working";
      if (this.host.deliverableOf(record) !== "change" || record.shape?.kind === "review")
        return `this work has no merge. ${fixedHoldWords("nothing-to-merge")}`;
      const destination = this.host.taskDelivery(taskId);
      if ((mode === "merge-pr") !== (destination === "direct-pr"))
        return "the requested destination does not match its current delivery policy";
      const gate = this.closeGateRefusal(taskId, mode, proceedWithOpen);
      if (gate) return gate.text;
      const autonomy = this.autonomyRefusal(record, mode, actor);
      if (autonomy) return autonomy.text;
      const cap = standingCap(record.delivery);
      if (cap) {
        const hold = cap.held === "ci-cap" ? "repairs" : "rounds";
        return `a repair allowance still needs the captain's answer. ${softHoldWords(hold, "firstmate")}`;
      }
      // The version a version-long override is read at: the one being sent.
      const at = head ?? record.delivery?.headSha;
      if (actor === "firstmate" && !overridePasses(record.delivery, "decisions", at)) {
        // The first mate's own cards never hold its own merge (INF-242's
        // question 9): a crewmate's question, a write request or a
        // validation question still does.
        const decisions = [...this.host.cards.values()].filter(
          (card) => card.taskId === taskId && card.actions.length,
        );
        const passed = new Set(
          decisions
            .filter((card) => isRoutineMergeCard(card) || card.author === "firstmate")
            .map((card) => card.id),
        );
        const gateIsPassed =
          record.gate?.kind === "captain" && record.gate.ref && passed.has(record.gate.ref);
        const wait = record.delivery?.captainWait;
        const waitIsPassed = wait?.cardId && passed.has(wait.cardId);
        if (
          decisions.some((card) => !passed.has(card.id)) ||
          (record.gate && !gateIsPassed) ||
          (wait && !waitIsPassed)
        )
          return `another decision or hold still needs attention. ${softHoldWords("decisions", "firstmate")}`;
      }
      const reviewed = this.policiesOf(record)?.rigor.value === "reviewed";
      const proof = acceptedValidation(record.delivery?.liveValidation, head);
      if (
        reviewed &&
        !(reviewCoversHead(record.delivery, head) && head) &&
        !overridePasses(record.delivery, "review", at)
      )
        return `the current version needs an independent review: ${proof.reason} ${softHoldWords("review", "firstmate")}`;
      const proofPassed = overridePasses(record.delivery, "live-proof", at);
      if (reviewed && !(head && proof.ready) && !proofPassed)
        return `the current version needs an independent review: ${proof.reason} ${softHoldWords("live-proof", "firstmate")}`;
      if (reviewed && !proofPassed) {
        if (
          !this.host.verifyValidationEvidence &&
          record.delivery?.liveValidation?.runs.at(-1)?.evidence.length
        )
          return "kept proof cannot be verified here";
        try {
          this.host.verifyValidationEvidence?.(taskId);
        } catch {
          return "kept proof changed or is missing; restore it or record and review new proof";
        }
      }
      this.sentMerges.add(taskId);
      return undefined;
    };
  }

  /**
   * A merge or land the captain asked for that a quit interrupted: resumed
   * once the Firstmate's wake path is attached, so its outcome is not lost.
   */
  resumePendingSettles(): void {
    for (const record of this.host.tasks.listLive()) {
      if (!record.pendingSettle) continue;
      void this.reportCardSettle(
        record.id,
        record.pendingSettle.mode,
        undefined,
        record.pendingSettle.proceedWithOpen,
      );
    }
  }

  /** Whether the task's crewmate is mid-turn. */
  private working(taskId: string): boolean {
    const state = this.host.runtimeState(taskId);
    return state !== undefined && state !== "idle";
  }

  /** Capture a merge/land intent and wait until the current turn is safely idle. */
  private waitForSettleBoundary(taskId: string, intent: PendingSettleIntent): Promise<void> {
    if (!this.working(taskId)) return Promise.resolve();
    this.host.tasks.setPendingSettle(taskId, intent);
    return new Promise((resolve) => {
      const waiters = this.settleBoundaryWaiters.get(taskId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.settleBoundaryWaiters.set(taskId, waiters);
    });
  }

  releaseSettleBoundary(taskId: string): void {
    const waiters = this.settleBoundaryWaiters.get(taskId);
    if (!waiters) return;
    this.settleBoundaryWaiters.delete(taskId);
    for (const wake of waiters) wake();
  }

  /**
   * The answer task's own close (Task B, captain F2 A). The captain's choice
   * on the card its own crewmate emitted closes it `done/answered`: the
   * deliverable was produced and he answered it, which is not the same as
   * declining a decision the Firstmate raised. His close control is not a
   * choice: it reaches the crewmate like every other card's close, and the
   * crewmate judges whether the task is finished (FI3-435) - the Firstmate
   * then closes it with settle_task `answered`. Interrupt, cancel and
   * `update_task drop` keep their own closes.
   */
  closeAnsweredTask(card: Card, action: string, by: "captain" | "firstmate" | "crewmate"): boolean {
    if (by !== "captain" || !card.taskId || action === "dismissed") return false;
    const record = this.host.tasks.get(card.taskId);
    if (record?.status !== "active" || record.kind !== "work") return false;
    // A card that asks to send a kept write is never the answer (FI3-1571
    // piece 4): its click sends or declines the write, and the task goes on.
    if (card.actions.some((action) => action.effect?.kind === "request_write")) return false;
    // Nor is a card its crewmate declared `continues` (INF-1226): something
    // it goes on from, such as INF-1220's consent "Allow signing on the Mac
    // mini" before anything was signed. Its choice reaches the crewmate, and
    // the task goes on.
    if (card.continues) return false;
    // Nor is a card that hands the captain its browser (INF-1322): INF-1317's
    // "Open browser and sign in" closed its read-only check answered, and the
    // close stopped the browser the captain had just taken. The crewmate goes
    // on from Return control, or hears any other choice on the card.
    if (card.attachment?.kind === "browser" && card.attachment.handoff) return false;
    // Its own crewmate's card, never a Firstmate card that happens to name
    // the task (`cardEmitter` reads the emitter off the id).
    if (cardEmitter(card.id, card.taskId) !== "crewmate") return false;
    const choice = card.actions.find((entry) => entry.id === action);
    // A plain result choice is a receipt, never consent or a merge effect.
    // Change tasks still wait for an explicit answered settle and a clean-work check.
    if (choice && !choice.effect)
      this.host.tasks.recordResultHandoff(record.id, { cardId: card.id, action });
    if (this.host.deliverableOf(record) !== "answer") return false;
    const text = action === "closed" ? "answer closed" : `chose "${choice?.label ?? action}"`;
    // An invalid action never produces a closure-choice wake.
    const handoff = choice ? this.answerTaskClosedPayload(record, card, choice) : undefined;
    void this.closeTask(card.taskId, {
      status: "done",
      reason: "answered",
      actor: "captain",
      text,
      ...(handoff ? { answerHandoff: handoff } : {}),
    }).catch(() => {});
    return true;
  }

  private answerTaskClosedPayload(
    task: TaskRecord,
    card: Card,
    choice: Card["actions"][number],
  ): AnswerTaskClosedPayload {
    return {
      version: 1,
      event: "answer_task_closed",
      task: { id: task.id, key: task.key, title: task.title },
      card: { id: card.id, title: card.title },
      choice: { id: choice.id, label: choice.label, effect: choice.effect ?? null },
      close: { status: "done", reason: "answered", actor: "captain" },
    };
  }

  private async landTaskOnce(
    taskId: string,
    actor: "captain" | "firstmate",
    beforeDispatch?: (head?: string) => string | undefined,
  ): Promise<SettleOutcome> {
    if (this.working(taskId)) {
      return {
        ok: false,
        text: "Cannot merge: the crewmate is still working; wait for its report or interrupt it first.",
      };
    }
    const record = this.host.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    if (record.status === "done" || record.status === "dropped") {
      return {
        ok: false,
        text: `Cannot merge: task ${taskId} is already ${describeStatus(record)}.`,
      };
    }
    // The close gate (children, blockers) is settleTaskOnce's single check,
    // which honors proceed_with_open before it reaches here (WI-12).
    try {
      // A branch on a computer that runs work merges from here once it is
      // home, in the repository it came home to.
      const home = record.deviceId ? await this.host.placed?.bringBranchHome(taskId) : undefined;
      const repoDir = home ?? record.repoDir;
      // A merge into a folder that is gone is refused, and the folder's
      // repair filed (INF-572).
      const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
      if (repo && repoDir && !existsSync(repoDir) && this.host.folderMissing) {
        const text = this.host.folderMissing(repo.id, "land", record);
        return { ok: false, text: `Cannot merge: ${text}`, problem: text };
      }
      const { mode } = await this.host.workspace.landTaskWork(
        {
          taskId,
          cwd: record.worktreeDir,
          branch: record.branch,
          repoDir,
        },
        beforeDispatch,
      );
      this.host.broadcastEvent({ type: "task_landed", taskId, title: record.title, mode });
      await this.closeTask(taskId, {
        status: "done",
        reason: "landed",
        actor,
        delivery: { landedMode: mode },
      });
      // Landing releases any queued row waiting on this task (R1).
      void this.host.sweepGates(this.host.now());
      return { ok: true, text: `Merged "${record.title}" into main.` };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return { ok: false, text: `Cannot merge: ${message}`, problem: message };
    }
  }

  private async mergePrTaskOnce(
    taskId: string,
    actor: "captain" | "firstmate",
    guard?: MergeGuard,
    beforeDispatch?: (head: string) => string | undefined,
  ): Promise<SettleOutcome> {
    if (this.working(taskId)) {
      return {
        ok: false,
        text: "Cannot merge yet: the crewmate is still working; wait for its report or interrupt it first.",
      };
    }
    const record = this.host.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    if (record.status === "done" || record.status === "dropped") {
      return {
        ok: false,
        text: `Cannot merge: task ${taskId} is already ${describeStatus(record)}.`,
      };
    }
    if (this.host.taskDelivery(taskId) !== "direct-pr") {
      return {
        ok: false,
        text: `Cannot merge: task ${taskId} does not deliver as a pull request.`,
      };
    }
    // The close gate is settleTaskOnce's single check (WI-12).
    if (!this.host.mergePullRequest) {
      // Named by where the project lives (git integration PR 1.3), never
      // assumed to be GitHub.
      const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
      const place = repo?.host ? forgePlace({ kind: repo.host.kind, host: repo.host.name }) : null;
      return {
        ok: false,
        text: `Cannot merge: ${place ?? "where the project lives"} is not reachable from here.`,
      };
    }
    const result = await this.host.mergePullRequest(
      taskId,
      guard,
      beforeDispatch
        ? { beforeDispatch, unattended: actor === "firstmate" || guard?.unattended === true }
        : undefined,
    );
    // The answer came: an attempt token has done its job, whatever it said.
    if (guard && result.stop !== "outcome") this.patchStanding(taskId, { attempt: undefined });
    if (!result.ok) {
      // The project's host needs the app's sign-in (git integration PR
      // 1.2): a typed refusal whose ways are the sign-in and keeping the
      // project on this Mac - the Firstmate carries them on one card.
      const refusal = result.signIn ? this.notSignedInRefusal(record, result.signIn) : undefined;
      return {
        ok: false,
        text: refusal ? `Cannot merge: ${refusal.text}` : result.text,
        ...(result.problem ? { problem: result.problem } : {}),
        ...(result.plain ? { plain: result.plain } : {}),
        ...(result.notGreen ? { notGreen: true } : {}),
        ...(result.stop ? { stop: result.stop } : {}),
        ...(refusal ? { refusal } : {}),
      };
    }
    if (guard) this.consumeStanding(taskId, result.receipt);
    return this.closeMerged(record, actor, result);
  }

  /**
   * INF-458: observing a merge is not permission to perform one. The shared
   * check watcher reads every live task's recorded pull request, even after
   * a plain-reply "I'll merge it" choice or while its computer is unreachable.
   * A merge is a forge fact; completion is the crewmate's declaration.
   * Never infer completion from PR ownership, a button label or a missing branch.
   */
  async reconcileExternalMerge(taskId: string): Promise<boolean> {
    const record = this.host.tasks.get(taskId);
    if (
      !record ||
      TaskService.isClosed(record) ||
      this.host.taskDelivery(taskId) !== "direct-pr" ||
      this.settlingTasks.has(taskId)
    )
      return false;
    this.settlingTasks.set(taskId, "merge-pr");
    try {
      const pull = await this.mergedOutside(record);
      const current = this.host.tasks.get(taskId);
      // A close or a different project/change took over while the read was out.
      if (
        !pull ||
        !current ||
        TaskService.isClosed(current) ||
        current.repoId !== record.repoId ||
        current.delivery?.prNumber !== pull.number
      )
        return false;
      this.host.tasks.recordChangeEvidence(taskId, {
        ci: "merged",
        headSha: pull.headSha,
        ciAt: this.host.now(),
        ciWatch: undefined,
      });
      const completion = current.delivery?.mergeCompletion;
      if (
        completion?.prNumber !== pull.number ||
        completion.headSha !== pull.headSha ||
        this.working(taskId) ||
        current.activity === "starting" ||
        current.activity === "running" ||
        current.activity === "interrupted" ||
        this.host.hasRunningJobs?.(taskId) ||
        current.delivery?.checkBack ||
        [...this.host.cards.values()].some(
          (card) => card.taskId === taskId && card.actions.length > 0 && !isRoutineMergeCard(card),
        ) ||
        this.host.inbox.allFor(taskId).length > 0 ||
        this.host.inbox.inFlight(taskId).length > 0 ||
        this.closeGateRefusal(taskId, "merge-pr", false)
      ) {
        const once = `external-merge:${pull.number}:${pull.headSha}`;
        if (!this.host.inbox.woken(taskId, once)) {
          this.host.inbox.enqueueSteerOnce(taskId, {
            facts: {
              kind: "external-merge",
              change: this.changeName(current, pull.number),
              head: pull.headSha,
            },
            once,
          });
        }
        return true;
      }
      await this.closeMergedOutside(taskId, "host", pull);
      return true;
    } finally {
      this.settlingTasks.delete(taskId);
    }
  }

  /**
   * The pull request the task names, when it reads merged by its number:
   * put in where the project lives outside the app (FI3-213). Undefined
   * when there is none, it is not merged, or it cannot be read.
   */
  private async mergedOutside(record: TaskRecord): Promise<ForgePull | undefined> {
    const prNumber = record.delivery?.prNumber;
    if (prNumber === undefined || !this.host.readPull) return undefined;
    const pull = await this.host.readPull(record.id, prNumber).catch(() => undefined);
    return pull?.merged && pull.number === prNumber ? pull : undefined;
  }

  /**
   * Close a task whose pull request was merged outside the app: nothing is
   * sent where the project lives, and the record closes as merged, the way
   * the captain's own merge click would have closed it.
   */
  private async closeMergedOutside(
    taskId: string,
    actor: TaskClose["actor"],
    pull: ForgePull,
  ): Promise<SettleOutcome> {
    if (this.working(taskId)) {
      return {
        ok: false,
        text: "Cannot merge yet: the crewmate is still working; wait for its report or interrupt it first.",
      };
    }
    const record = this.host.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    return this.closeMerged(record, actor, {
      ok: true,
      text: `${this.changeName(record, pull.number)} is already merged on ${this.placeOf(record)}.`,
      receipt: {
        head: pull.headSha,
        ...(pull.mergedSha ? { sha: pull.mergedSha } : {}),
        already: true,
      },
    });
  }

  /** A merged task's close: the record, the managed checkout, and the gates it releases. */
  private async closeMerged(
    record: TaskRecord,
    actor: TaskClose["actor"],
    result: PrOutcome,
  ): Promise<SettleOutcome> {
    const taskId = record.id;
    await this.closeTask(
      taskId,
      {
        status: "done",
        reason: "merged",
        actor,
        text: result.text,
        delivery: { landedMode: "pr" },
      },
      { recordBeforeStop: actor === "host" },
    );
    let refreshText = "";
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    if (
      repo &&
      record.repoId &&
      this.host.repos.managesProjectPath(record.repoId, repo.path) &&
      typeof this.host.workspace.refreshManagedCheckout === "function"
    ) {
      const refresh = await this.host.workspace
        .refreshManagedCheckout(repo.path)
        .catch((): FolderRefreshRefusal => ({ refreshed: false, cause: "unreadable" }));
      refreshText = refresh.refreshed
        ? " The managed checkout is up to date."
        : ` ${this.folderNotUpdated(record, actor, refresh, result.receipt?.sha)}`;
    }
    void this.host.sweepGates(this.host.now());
    return {
      ok: true,
      text: `${result.text}${refreshText}`,
      ...(result.receipt ? { receipt: result.receipt } : {}),
    };
  }

  /**
   * A merge whose project folder the host could not bring up to date
   * (INF-549): the typed fact is kept on the merged task's record, the task
   * that brings the folder up to date is filed (or the standing one told),
   * and the sentence returns for the settle's own text. The captain's click
   * already puts that text in Activity (`reportOutcome`); the first mate's
   * own settle has no line of its own, so its note is the line.
   */
  private folderNotUpdated(
    record: TaskRecord,
    actor: TaskClose["actor"],
    refusal: FolderRefreshRefusal,
    reach: string | undefined,
  ): string {
    let repair: { record: TaskRecord; filed: boolean } | undefined;
    try {
      repair = this.host.fileFolderRepair?.(record, { ...refusal, ...(reach ? { reach } : {}) });
    } catch (caught) {
      console.warn("[settle] the folder repair could not be filed:", caught);
    }
    const text = folderNotUpdatedText(
      refusal.cause,
      repair ? { key: repair.record.key || repair.record.id, filed: repair.filed } : undefined,
    );
    this.host.tasks.note(record.id, text, {
      news: true,
      feed: actor !== "captain",
      data: {
        feedLine: true,
        folderRefresh: {
          cause: refusal.cause,
          ...(refusal.branch ? { branch: refusal.branch } : {}),
          ...(reach ? { reach } : {}),
          ...(refusal.remote ? { remote: refusal.remote } : {}),
          ...(repair ? { repair: repair.record.id } : {}),
        },
      },
      ...(repair ? { about: [repair.record.id] } : {}),
    });
    return text;
  }

  /**
   * The captain's click on `request_merge`. Declaring the action merged
   * nothing; this runs only from that click. An owned review finishes the
   * task. A referenced review keeps the task and its working copy.
   */
  async requestMerge(
    taskId: string,
    reviewId: string,
    unattended = false,
  ): Promise<SettleOutcome & { continued?: boolean }> {
    const refuse = (result: SettleOutcome): SettleOutcome => {
      const review = this.host.tasks
        .get(taskId)
        ?.delivery?.mergeReviews?.find((item) => item.id === reviewId);
      if (!unattended) this.host.mergeContinued?.(taskId, review, result);
      return result;
    };
    if (this.settlingTasks.has(taskId)) {
      return refuse({
        ok: false,
        text: "Cannot merge: another settle is already in progress.",
        contention: true,
      });
    }
    const record = this.host.tasks.get(taskId);
    if (!record) return refuse({ ok: false, text: `Cannot merge: unknown task ${taskId}.` });
    if (record.status === "done" || record.status === "dropped") {
      return refuse({
        ok: false,
        text: `Cannot merge: task ${taskId} is already ${describeStatus(record)}.`,
      });
    }
    if (!this.host.mergeReview) {
      return refuse({
        ok: false,
        text: "Cannot merge: where the project lives is not reachable from here.",
      });
    }
    const authorization = standingAuthorization(record.delivery);
    const approved = authorization?.review?.id === reviewId ? authorization : undefined;
    const review =
      approved?.review ?? record.delivery?.mergeReviews?.find((item) => item.id === reviewId);
    if (unattended && !approved)
      return { ok: false, stop: "withdrawn", text: "The kept merge approval no longer stands." };
    this.settlingTasks.set(taskId, "merge-pr");
    try {
      const result = await this.host.mergeReview(
        taskId,
        reviewId,
        approved ? this.guardOf(taskId, approved, unattended) : undefined,
      );
      if (!result.ok) {
        const kept = approved ? this.afterAttempt(taskId, approved, result) : undefined;
        const outcome = kept
          ? {
              ...result,
              text: `${result.text}\n\n${keptNote(kept.wait, kept.head, this.placeOf(record))}`,
            }
          : result;
        if (kept?.changed && unattended)
          this.noteWait(taskId, record.title, kept.head, result, kept.wait);
        else if (kept?.changed) {
          this.host.broadcastEvent({
            type: "firstmate_note",
            taskId,
            text: keptFeedLine(
              record.title,
              kept.wait,
              this.placeOf(record),
              this.host.tasks.get(taskId)?.delivery?.ci,
            ),
          });
        }
        if (!unattended && review) this.host.mergeContinued?.(taskId, review, outcome);
        return outcome;
      }
      if (result.relationship === "referenced" && review) {
        this.finishReferenced(taskId, review, result);
        return { ...result, continued: true };
      }
      return this.closeMerged(record, "captain", result);
    } finally {
      this.settlingTasks.delete(taskId);
    }
  }

  private finishReferenced(taskId: string, review: MergeReview, result: SettleOutcome): void {
    this.host.tasks.atomic(
      () => {
        const authorization = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
        if (
          authorization?.review?.id === review.id &&
          candidateHead(authorization) === result.receipt?.head
        )
          this.consumeStanding(taskId, result.receipt);
        else if (authorization?.review?.id === review.id)
          this.endAuthorization(
            taskId,
            "invalidated",
            "the pull request merged at a different version",
            { feed: true },
          );
        this.host.tasks.activateRequiredActions(taskId);
        this.host.tasks.note(taskId, result.text, { news: true, feed: true, actor: "host" });
      },
      () => {},
    );
    // The committed task note already reaches Activity through the task-event seam.
    this.host.mergeContinued?.(taskId, review, result);
  }

  /**
   * What forbids this task's record from closing (WI-12): an open child (the
   * parent close rule) or live work it waits on (the blocks rule), as a
   * structured refusal whose ways the Firstmate turns into effect buttons. A
   * discard abandons the work rather than completing it, so a wait on other
   * work cannot forbid it - only containment can. `proceed_with_open` is the
   * captain's leave to settle the task and keep its open children planned,
   * and so is his recorded override on the open parts; his override on the
   * waits passes a `blocks_me` promise.
   */
  private closeGateRefusal(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    proceedWithOpen: boolean,
  ): SettleRefusal | undefined {
    const delivery = this.host.tasks.get(taskId)?.delivery;
    // The captain's override on the open parts is his leave to settle
    // keeping them planned, the same as `proceed_with_open`.
    if (!proceedWithOpen && !overridePasses(delivery, "parts", delivery?.headSha)) {
      const children = this.host.tasks.closeRefusal(taskId);
      if (children) {
        const refusal = this.withProceedWay(children, taskId, mode);
        return { ...refusal, text: `${refusal.text} ${softHoldWords("parts", "firstmate")}` };
      }
    }
    if (mode === "discard") return undefined;
    const waits = this.host.tasks.blockerRefusal(taskId);
    return waits
      ? { ...waits, text: `${waits.text} ${softHoldWords("waits", "firstmate")}` }
      : waits;
  }

  /**
   * The mode's `proceed_with_open` way, first (its default), on a children-open
   * refusal. The refusal's own text already names "settle keeping them
   * planned", so only the runnable way is added here.
   */
  private withProceedWay(
    refusal: SettleRefusal,
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
  ): SettleRefusal {
    const verb = mode === "discard" ? "Discard" : MERGE_WORDS[mode];
    const them = refusal.tasks.length === 1 ? "it" : "them";
    const way: SettleWay = {
      label: `${verb}, keeping ${them} planned`,
      tool: "settle_task",
      args: { task_id: taskId, mode, proceed_with_open: true },
    };
    return { ...refusal, ways: [way, ...refusal.ways] };
  }

  /** A discard that would destroy unlanded work, as a structured refusal (WI-12). */
  private unlandedWorkRefusal(
    record: TaskRecord,
    work: { dirty: boolean; unlandedCommits: number },
  ): SettleRefusal {
    const task = { id: record.id, key: record.key || record.id, title: record.title };
    const keepMode = this.host.taskDelivery(record.id) === "direct-pr" ? "merge-pr" : "land";
    const ways: SettleWay[] = [
      {
        label: "Discard anyway",
        tool: "settle_task",
        args: { task_id: record.id, mode: "discard", confirm: true },
      },
      {
        label: `${MERGE_WORDS[keepMode]} instead`,
        tool: "settle_task",
        args: { task_id: record.id, mode: keepMode },
      },
    ];
    const text = unlandedWorkText(task, work, keepMode);
    return { refused: "unlanded-work", task, tasks: [], ways, text };
  }

  /**
   * A discard of a task whose working copy is on a computer that is out of
   * reach: nobody can read what it holds. Its work still comes here before
   * that computer deletes it, so confirming loses nothing.
   */
  private unreadableWorkRefusal(record: TaskRecord): SettleRefusal {
    const task = { id: record.id, key: record.key || record.id, title: record.title };
    const ways: SettleWay[] = [
      {
        label: "Discard anyway",
        tool: "settle_task",
        args: { task_id: record.id, mode: "discard", confirm: true },
      },
    ];
    const text = `Cannot discard ${task.key} "${record.title}" without confirm: its working copy is on a computer that is out of reach, so nobody can tell whether it holds unmerged work. Its work comes to ${HERE.this} before that computer deletes its copy; discard with confirm to go ahead.`;
    return { refused: "unlanded-work", task, tasks: [], ways, text };
  }

  /** The not-signed-in refusal on a task's settle, with the sign-in's two ways. */
  private notSignedInRefusal(
    record: TaskRecord,
    fact: { host: string; name: string; repoId?: string },
  ): SettleRefusal {
    const refusal = signInRefusal({
      ...fact,
      context: `merging "${record.title}" needs the captain's ${fact.name} sign-in, or the project kept on ${HERE.this}.`,
    });
    return {
      refused: "not-signed-in",
      task: { id: record.id, key: record.key || record.id, title: record.title },
      tasks: [],
      ways: refusal.ways,
      text: `${refusal.text} ${fixedHoldWords("sign-in")}`,
    };
  }

  /**
   * The autonomy hold, as a structured refusal (captain ruling 2026-09-20:
   * "this should actually be the same - repo default, per-task ask
   * allowed"). Autonomy off means a green result is the captain's call, and
   * until now only the Firstmate's own prompt said so - a rule an
   * instruction can lose, on the one move that cannot be taken back. So the
   * HOST refuses it: a Firstmate merge or land on a task whose effective
   * autonomy is off settles nothing.
   *
   * The captain is never refused: his click arrives as `actor: "captain"`,
   * from the card's settle effect or the shell, and this rule does not read
   * it. Autonomy off means the merge is his to make, so his click IS the
   * way out - not a relay of it through the Firstmate, which is the move
   * the hold exists to stop.
   *
   * The one way out is that click, so the refusal names the button it is
   * already sitting on rather than a tool: the completion card's merge
   * action, by card id and action id. With no such card open there is
   * nothing to point at, and the text says whose card is owed instead.
   */
  private autonomyRefusal(
    record: TaskRecord,
    mode: "merge-pr" | "land",
    actor: "captain" | "firstmate",
  ): SettleRefusal | undefined {
    if (actor === "captain") return undefined;
    // His own words to the first mate are his consent too: an override on
    // asking first lets the first mate's merge through.
    if (overridePasses(record.delivery, "asks-first", record.delivery?.headSha)) return undefined;
    // A withdrawn or outgrown merge approval holds the task for the captain
    // whatever the project's autonomy says (FI3-304): only his new click
    // merges it.
    const hold = mergeHold(record.delivery);
    if (!hold && this.host.taskAutonomy(record.id)) return undefined;
    const task = { id: record.id, key: record.key || record.id, title: record.title };
    const verb = mode === "merge-pr" ? "Merging the pull request for" : "Merging";
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    const standing = repo ? `${repo.name} asks before merging` : "this task has no repository";
    const open = this.host.cards.openMergeAction(record.id);
    const ways: SettleWay[] = open
      ? [{ label: open.label, card: { id: open.cardId, action: open.actionId } }]
      : [];
    const pointer = open
      ? `The completion card "${open.cardTitle}" is on the stack with its "${open.label}" button: that click is the merge, and it is the captain's to make. Nothing further is needed from you.`
      : "The captain merges it from the crewmate's completion card; steer the crewmate to emit one if it has not.";
    const why = hold
      ? `the captain's merge approval ended because ${hold}, so the merge is theirs again`
      : `autonomy is off for this task (${standing})`;
    return {
      refused: "autonomy-off",
      task,
      tasks: [],
      ways,
      text: `${verb} ${task.key} "${record.title}" is not yours to do: ${why}. ${pointer} ${softHoldWords("asks-first", "firstmate")}`,
    };
  }

  /**
   * settle_task mode `answered`: the one path besides the captain's own that
   * closes an ANSWER task (the Task B rule, revised by the captain's call C
   * of 2026-09-24). Whether a task is the Firstmate's own internal step or
   * something the captain asked for is the Firstmate's judgment, taught by
   * its instructions and declared when it creates the task
   * (`internal_step`); the host infers nothing and only honours that
   * declaration. An idle answer task declared as a step, whose answer a live
   * task has taken as its basis - planned or started - has done its job: its
   * report and card carry on in that task's brief. So has a step a live task
   * waits on through a blocks link (FI3-422): it was run for that task, and
   * its close as done is what clears the wait. It closes `done/answered`
   * with one feed line naming where the answer went, never as a discard.
   * An answer the captain asked for closes here too once its crewmate's
   * report declared it finished - he closed its card and nothing is left
   * (FI3-435) - with nothing built on it required. So does a step whose
   * crewmate reported its answer when no task builds on it (INF-1137): the
   * first mate passed the answer on by a steer, and a finished answer is
   * never closed as a discard.
   * A verified result receipt also lets the first mate finish reported idle
   * work not declared internal, including file-producing change tasks, after
   * checking that no unmerged work or proposed change would be bypassed.
   * Refused, as text, on a change without that receipt, one neither declared
   * a step nor declared finished nor holding a receipt, one still working or never started, a
   * step that reported nothing and no live task builds on or waits on, one
   * whose own answer card is still waiting on the captain - his choice is
   * that card's close -
   * and one whose Firstmate card still asks him something, because the
   * close would take that question down. A Firstmate note stays up.
   */
  async closeAnswerUsedAsBasis(taskRef: string): Promise<{ ok: boolean; text: string }> {
    const record = this.host.resolveTaskRef(taskRef, "task_id");
    const handle = `${record.key || record.id} "${record.title}"`;
    const refuse = (why: string) => ({
      ok: false,
      text: `Cannot close ${handle} as answered: ${why}`,
    });
    if (record.kind !== "work") return refuse("it is not crew work.");
    if (TaskService.isClosed(record)) {
      return refuse(`it is already ${describeStatus(record)}.`);
    }
    if (this.host.deliverableOf(record) === "operation")
      return refuse(
        "it delivers an effect, not an answer - verify it and close it finished with completion_evidence.",
      );
    const handedOn = this.host.tasks.resultHandoffOf(record.id);
    const change = this.host.deliverableOf(record) !== "answer";
    if (change && !handedOn) {
      return refuse(
        "it delivers a change, not an answer - merge it, land it, or discard it instead.",
      );
    }
    const finished = record.delivery?.finishedAt !== undefined;
    if (!record.shape?.internal_step && !finished && !handedOn) {
      return refuse(
        "it was not opened as an internal step of yours - the captain asked for this answer, so it closes on their choice on its card, or once its crewmate reports it finished after they close that card.",
      );
    }
    if (record.status !== "active" || this.working(record.id)) {
      return refuse(
        record.status === "open"
          ? "it has not run yet, so there is no answer to close on."
          : "its crewmate is still working; wait for its report.",
      );
    }
    if (record.activity && record.activity !== "idle") {
      return refuse("its crewmate is still working; wait for its report.");
    }
    if (handedOn) {
      if (!record.outcome?.trim()) return refuse("its crewmate has not reported the result yet.");
      if (record.delivery?.prUrl || record.delivery?.prNumber || record.delivery?.changeLabel)
        return refuse("it has its own pull request; use its delivery path instead.");
      const gate =
        this.host.tasks.closeRefusal(record.id) ?? this.host.tasks.blockerRefusal(record.id);
      if (gate) return refuse(gate.text);
      if (record.worktreeDir || record.branch || record.deviceId) {
        const work = await (record.deviceId
          ? (this.host.placed?.workStatus(record.id) ?? Promise.resolve(null))
          : this.host.workspace.taskWorkStatus(workspaceOf(record), { strict: true })
        ).catch(() => null);
        if (!work) return refuse("its working copy could not be checked; keep the task open.");
        if (work.dirty || work.unlandedCommits > 0)
          return refuse(
            "its working copy has uncommitted edits or unmerged commits; use its delivery path instead.",
          );
        const current = this.host.tasks.get(record.id);
        if (
          current?.status !== "active" ||
          current.activity !== "idle" ||
          this.working(record.id) ||
          current.updatedAt !== record.updatedAt
        )
          return refuse(
            "its work changed during the check; read its latest report before closing it.",
          );
      }
    }
    const builtOn = this.host.tasks
      .listLive()
      .filter((task) => task.id !== record.id && task.shape?.basis)
      .find((task) => this.host.tasks.resolve(task.shape?.basis ?? "")?.id === record.id);
    // A live task that waits on it through a blocks link is the other place
    // its answer goes on (FI3-422): the step was run for that task, and
    // closing it done is what clears the wait.
    const waitedOnBy = builtOn
      ? undefined
      : this.host.tasks.blocking(record.id).find((task) => !TaskService.isClosed(task));
    const carriedBy = builtOn ?? waitedOnBy;
    // A step whose crewmate reported its answer has done its job even when
    // no task builds on it: the first mate passed the answer on itself, by a
    // steer (INF-1137). Without a report there is nothing to close on.
    const reported = record.outcome !== null;
    if (!carriedBy && !finished && !reported) {
      return refuse(
        `its crewmate has reported no answer yet, and no planned or started task names it as its basis or waits on it. Wait for its report, or start or plan the step that builds on it with basis ${record.key || record.id}.`,
      );
    }
    const card = this.host.cards.snapshot().find((entry) => holdsAnswerClose(entry, record.id));
    if (card) {
      return refuse(
        cardEmitter(card.id, record.id) === "crewmate"
          ? `its answer card "${card.title}" is waiting on the captain, and their choice there is its close.`
          : `its card "${card.title}" still asks the captain something, and closing now would take it down before they have answered it.`,
      );
    }
    if (handedOn) {
      const gate =
        this.host.tasks.closeRefusal(record.id) ?? this.host.tasks.blockerRefusal(record.id);
      if (gate) return refuse(gate.text);
      if (
        this.host.hasRunningJobs?.(record.id) ||
        this.host.inbox.allFor(record.id).length ||
        this.host.inbox.inFlight(record.id).length ||
        record.delivery?.checkBack ||
        record.pendingSettle
      )
        return refuse("work or guidance is still outstanding; let its crewmate finish first.");
      await this.closeTask(record.id, {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text: "answered - its reported result was handed on",
        data: { handedOn: true },
      });
      return { ok: true, text: `Closed ${handle} as answered: its reported result was handed on.` };
    }
    if (!carriedBy && finished) {
      await this.closeTask(record.id, {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text: "answered - the captain read it and its crewmate finished",
      });
      return { ok: true, text: `Closed ${handle} as answered: the captain has read it.` };
    }
    if (!carriedBy) {
      await this.closeTask(record.id, {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text: "answered - its crewmate reported the answer",
        data: { reported: true },
      });
      return { ok: true, text: `Closed ${handle} as answered: its crewmate reported the answer.` };
    }
    const successor = `${carriedBy.key || carriedBy.id} "${carriedBy.title}"`;
    await this.closeTask(record.id, {
      status: "done",
      reason: "answered",
      actor: "firstmate",
      text: `answered - its answer carries on in ${successor}`,
      data: builtOn ? { basisOf: builtOn.id } : { waitedOnBy: carriedBy.id },
    });
    return {
      ok: true,
      text: `Closed ${handle} as answered: its answer carries on in ${successor}.`,
    };
  }

  /**
   * INF-1279 and INF-1430: the first mate declares verified operational
   * success, including legacy folder work. Evidence is its judgment, not
   * a host interpretation of prose. Never inspect, commit or merge as proof;
   * the ordinary close owner retires a scratch copy and leaves a folder alone.
   */
  async closeFinishedFolderWork(
    taskRef: string,
    completionEvidence: string,
  ): Promise<{ text: string; refusal?: SettleRefusal }> {
    const record = this.host.resolveTaskRef(taskRef, "task_id");
    const handle = `${record.key || record.id} "${record.title}"`;
    const refuse = (why: string) => ({ text: `Cannot close ${handle} as finished: ${why}` });
    if (this.settlingTasks.has(record.id) || record.pendingSettle)
      return refuse("another settle is already in progress.");
    if (
      record.kind !== "work" ||
      !(
        this.host.deliverableOf(record) === "operation" ||
        (this.host.deliverableOf(record) === "change" && isFolderWork(record.shape?.in_place))
      ) ||
      this.host.isPersonalTask(record.id)
    )
      return refuse(
        "this mode is for an operation or work run in a project's folder, not an answer or a change to merge.",
      );
    if (
      this.host.deliverableOf(record) !== "operation" &&
      (record.worktreeDir || record.branch || record.deviceId)
    )
      return refuse(
        "this task has a working copy or branch of its own; use its delivery path instead.",
      );
    if (record.status !== "active" || record.activity !== "idle" || this.working(record.id))
      return refuse("wait for its crewmate to finish and report first.");
    if (!record.outcome?.trim()) return refuse("its crewmate has not reported the result yet.");
    const evidence = completionEvidence.trim();
    if (!evidence) return refuse("name the completed result and the evidence that verifies it.");
    if (record.delivery?.prUrl || record.delivery?.prNumber || record.delivery?.changeLabel)
      return refuse("this task has its own pull request; use its delivery path instead.");
    if (
      this.host.hasRunningJobs?.(record.id) ||
      record.delivery?.checkBack ||
      this.host.inbox.allFor(record.id).length ||
      this.host.inbox.inFlight(record.id).length
    )
      return refuse("work or guidance is still outstanding; let its crewmate finish it first.");
    if (
      !overridePasses(record.delivery, "decisions", record.delivery?.headSha) &&
      (record.gate ||
        record.delivery?.captainWait ||
        this.host.cards.snapshot().some((card) => card.taskId === record.id && card.actions.length))
    )
      return refuse(
        `another decision or hold still needs attention. ${softHoldWords("decisions", "firstmate")}`,
      );
    const gate =
      this.host.tasks.closeRefusal(record.id) ?? this.host.tasks.blockerRefusal(record.id);
    if (gate) return { text: gate.text, refusal: gate };
    this.settlingTasks.set(record.id, "finished");
    try {
      // All reads above are synchronous. Commit before stopping can yield,
      // so newly arriving guidance sees a closed task rather than being lost.
      await this.closeTask(
        record.id,
        {
          status: "done",
          reason: "finished",
          actor: "firstmate",
          text: `finished: ${evidence}`,
          data: { completionEvidence: evidence },
        },
        { recordBeforeStop: true },
      );
      return { text: `Closed ${handle} as finished: ${evidence}` };
    } finally {
      this.settlingTasks.delete(record.id);
    }
  }

  /**
   * Close work already delivered by an independent release process. This is
   * an explicit Firstmate declaration backed by a specific verified release,
   * not an inference from a missing proposed change or a dismissed card.
   * Refuse local work that could be lost; the ordinary put-in/discard paths
   * remain available for it. No forge merge or PR close is attempted here.
   */
  async closeExternallyReleased(
    taskRef: string,
    releaseEvidence: string,
  ): Promise<{ text: string; refusal?: SettleRefusal }> {
    const record = this.host.resolveTaskRef(taskRef, "task_id");
    const handle = `${record.key || record.id} "${record.title}"`;
    const refuse = (why: string) => ({ text: `Cannot close ${handle} as released: ${why}` });
    if (this.settlingTasks.has(record.id) || record.pendingSettle)
      return refuse("another settle is already in progress.");
    if (record.kind !== "work" || this.host.deliverableOf(record) !== "change")
      return refuse("this is not a work task delivering a change.");
    if (this.host.isPersonalTask(record.id))
      return refuse("the personal workspace builds in place and closes from its report.");
    if (record.status !== "active" || record.activity !== "idle" || this.working(record.id))
      return refuse("wait for its crewmate to finish and report first.");
    if (!record.outcome) return refuse("its crewmate has not reported the result yet.");
    const evidence = releaseEvidence.trim();
    if (!evidence)
      return refuse("name the release and the evidence that its delivery was verified.");
    if (record.delivery?.prUrl || record.delivery?.prNumber || record.delivery?.changeLabel)
      return refuse(
        "this task has its own pull request; settle it with merge-pr instead, which closes the task as merged when the pull request was already merged where the project lives.",
      );
    if ((!record.deviceId && !record.worktreeDir) || record.workspaceState !== "present")
      return refuse("its working copy is unavailable; check the work before closing it.");
    const gate =
      this.host.tasks.closeRefusal(record.id) ?? this.host.tasks.blockerRefusal(record.id);
    if (gate) return { text: gate.text, refusal: gate };
    this.settlingTasks.set(record.id, "external release");
    try {
      // Read the working copy where the task ran, just as discard does.
      // A missing computer or working copy is not proof of released work.
      const work = await (record.deviceId
        ? (this.host.placed?.workStatus(record.id) ?? Promise.resolve(null))
        : this.host.workspace.taskWorkStatus(workspaceOf(record), { strict: true })
      ).catch((caught) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        return { inspectionFailure: message };
      });
      if (!work)
        return refuse("its working copy is unavailable; check the work before closing it.");
      if ("inspectionFailure" in work)
        return refuse(`the working copy could not be checked: ${work.inspectionFailure}`);
      if (work.dirty || work.unlandedCommits > 0)
        return refuse(
          "its working copy has uncommitted edits or commits not in the project. Put them in or resolve them before closing it.",
        );
      // Recheck after the asynchronous work read: a concurrent turn may have
      // started or a card may have placed a new gate in the meantime.
      const current = this.host.tasks.get(record.id);
      if (
        this.working(record.id) ||
        current?.status !== "active" ||
        current.activity !== "idle" ||
        current.pendingSettle ||
        current.deviceId !== record.deviceId ||
        current.worktreeDir !== record.worktreeDir ||
        current.workspaceState !== "present" ||
        current.delivery?.prUrl ||
        current.delivery?.prNumber ||
        current.delivery?.changeLabel
      )
        return refuse("its state changed while the working copy was checked; try again.");
      const newGate =
        this.host.tasks.closeRefusal(record.id) ?? this.host.tasks.blockerRefusal(record.id);
      if (newGate) return { text: newGate.text, refusal: newGate };
      await this.closeTask(record.id, {
        status: "done",
        reason: "released",
        actor: "firstmate",
        text: `released outside this task: ${evidence}`,
        data: { releaseEvidence: evidence },
        // No new fact, but the close still records the posture it ends under.
        delivery: {},
      });
      return { text: `Closed ${handle} as released outside this task: ${evidence}.` };
    } finally {
      this.settlingTasks.delete(record.id);
    }
  }

  /**
   * Conversational merge-pr / land / discard. Fail-closed reasons return as
   * the result text so Firstmate can judge the standing card rule; this
   * method never mints a card.
   */
  async settleTask(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm?: boolean,
    actor: "captain" | "firstmate" = "firstmate",
    proceedWithOpen = false,
  ): Promise<string> {
    const result = await this.settleTaskGuarded(taskId, mode, confirm, actor, proceedWithOpen);
    this.recordRefusal(taskId, mode, result);
    return result.text + this.missingValidationBrief(taskId, mode, result);
  }

  private missingValidationBrief(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    result: SettleOutcome,
  ): string {
    const record = this.host.tasks.get(taskId);
    return mode !== "discard" &&
      !result.ok &&
      record &&
      this.policiesOf(record)?.rigor.value === "reviewed" &&
      !acceptedValidation(
        record.delivery?.liveValidation,
        record.delivery?.headSha ?? record.delivery?.validationHead,
      ).ready &&
      !this.host.tasks.briefContains(taskId, CAREFUL_LIVE_VALIDATION)
      ? `\n\nRelay this missing contract to the builder, even if its completion card is already up; other holds still apply: ${CAREFUL_LIVE_VALIDATION}`
      : "";
  }

  /**
   * The settle a tool runs (WI-12): its prose for the tool result's content,
   * and the structured refusal, when there is one, for its `details` - so
   * the Firstmate can carry the ways out as effect buttons on one card.
   */
  async settleTaskDetailed(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm?: boolean,
    proceedWithOpen?: boolean,
    actor: "captain" | "firstmate" = "firstmate",
  ): Promise<{ text: string; refusal?: SettleRefusal }> {
    const result = await this.settleTaskGuarded(
      taskId,
      mode,
      confirm,
      actor,
      proceedWithOpen ?? false,
    );
    this.recordRefusal(taskId, mode, result);
    return {
      text: result.text + this.missingValidationBrief(taskId, mode, result),
      ...(result.refusal ? { refusal: result.refusal } : {}),
    };
  }

  /**
   * A refused merge is a row on the task's record, whatever stopped it
   * (FI3-1189's rule 1), and the tasks the refusal names - the blockers it
   * waits on, the parts still open - read it too (`TaskService.note`'s
   * `about`). Contention is not an outcome, and a refused discard is a row
   * only with a problem, as before.
   */
  private recordRefusal(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    result: SettleOutcome,
  ): void {
    if (result.ok || result.contention || !this.host.tasks.get(taskId)) return;
    if (mode === "discard") {
      if (result.problem) {
        this.host.tasks.note(taskId, result.text, {
          news: true,
          data: { problem: result.problem },
        });
      }
      return;
    }
    this.host.tasks.note(taskId, result.text, {
      news: true,
      data: { refused: mode, ...(result.problem ? { problem: result.problem } : {}) },
      about: result.refusal?.tasks.map((task) => task.id) ?? [],
    });
  }

  /** Same as settleTask, with the ok/refused distinction a card retry needs. */
  private async settleTaskGuarded(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm: boolean | undefined,
    actor: "captain" | "firstmate",
    proceedWithOpen = false,
    guard?: MergeGuard,
  ): Promise<SettleOutcome> {
    const pending = this.settlingTasks.get(taskId);
    if (pending) {
      return {
        ok: false,
        contention: true,
        text: `Cannot ${mode} task ${taskId}: ${pending} is already in progress. Wait for its outcome.`,
      };
    }
    // The personal workspace (Step 4) has no settle at all: the work is already in
    // place and committed at every turn, and a report closes the task. Said
    // before the boundary wait, which would otherwise hold a land or merge
    // until the crewmate's turn ends for nothing.
    if (this.host.isPersonalTask(taskId)) {
      const record = this.host.tasks.get(taskId);
      if (!record) throw new Error(`Unknown task "${taskId}".`);
      return {
        ok: false,
        text: `Task ${taskId} "${record.title}" builds in place on the personal workspace: its changes are already there and committed, so there is nothing to merge, land, or discard. Ask for the change you want instead${
          this.host.runtimeState(taskId) ? ", or interrupt it with mode cancel to stop it" : ""
        }. ${fixedHoldWords("nothing-to-merge")}`,
      };
    }
    // An answer task ships nothing (Task B): there is no branch to land and
    // no pull request to merge, because its brief told the crewmate to
    // commit nothing. Discard stays - it is the captain's cleanup of a
    // laboratory - and resolving the card is the ordinary close. Said here,
    // like the personal refusal, so it never waits out a turn for nothing.
    if (mode === "merge-pr" || mode === "land") {
      const record = this.host.tasks.get(taskId);
      if (!record) throw new Error(`Unknown task "${taskId}".`);
      if (this.host.deliverableOf(record) === "operation")
        return {
          ok: false,
          text: `Nothing to merge: this task delivers an operation, not code. Verify the effect and close it finished with completion_evidence. ${fixedHoldWords("nothing-to-merge")}`,
        };
      if (this.host.deliverableOf(record) === "answer") {
        return {
          ok: false,
          text: `Nothing to ${mode === "merge-pr" ? "merge" : "land"}: task ${taskId} "${record.title}" delivers an answer, not a change - it commits nothing and opens no pull request, and its card is the deliverable. It closes when the captain resolves that card; discard it if its worktree should go now. ${fixedHoldWords("nothing-to-merge")}`,
        };
      }
    }
    // One owner across cards, the shell, and conversational tools. Claim
    // before the first await, and retain it through worktree cleanup.
    this.settlingTasks.set(taskId, mode);
    const boundary =
      mode === "discard" ? undefined : this.mergeBoundary(taskId, mode, actor, proceedWithOpen);
    try {
      if (mode === "merge-pr" || mode === "land") {
        const existing = this.host.tasks.get(taskId)?.pendingSettle;
        await this.waitForSettleBoundary(
          taskId,
          existing ?? { mode, actor, requestedAt: this.host.now(), proceedWithOpen },
        );
      }
      return await this.settleTaskOnce(
        taskId,
        mode,
        confirm,
        actor,
        proceedWithOpen,
        guard,
        boundary,
      );
    } finally {
      if (mode === "merge-pr" || mode === "land") {
        const record = this.host.tasks.get(taskId);
        if (record?.pendingSettle) this.host.tasks.setPendingSettle(taskId, null);
      }
      this.settlingTasks.delete(taskId);
      this.sentMerges.delete(taskId);
    }
  }

  private async settleTaskOnce(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm: boolean | undefined,
    actor: "captain" | "firstmate",
    proceedWithOpen: boolean,
    guard?: MergeGuard,
    boundary?: (head?: string) => string | undefined,
  ): Promise<SettleOutcome> {
    const record = this.host.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    if (record.kind === "decision") {
      throw new Error(`Task ${taskId} is a decision, not crew work.`);
    }
    // The close rules (P2): every settle mode closes the record. A structured
    // refusal carries its ways out (WI-12); the prose still leads the result.
    const gateRefusal = this.closeGateRefusal(taskId, mode, proceedWithOpen);
    if (gateRefusal) {
      const prefix = mode === "discard" ? "" : "Cannot merge: ";
      // A held merge reads in plain words on the feed, with no tool names.
      const plain =
        mode !== "discard" && gateRefusal.refused === "waits-on" && gateRefusal.tasks?.length
          ? `it is still waiting on ${gateRefusal.tasks.map((t) => `"${t.title}"`).join(", ")} to finish, so the merge was held back`
          : undefined;
      return {
        ok: false,
        text: `${prefix}${gateRefusal.text}`,
        ...(plain ? { plain } : {}),
        refusal: gateRefusal,
      };
    }
    if (mode === "merge-pr" || mode === "land") {
      // The autonomy hold, before anything merges or lands.
      const held = this.autonomyRefusal(record, mode, actor);
      // The hold keeps a merge for the captain; one already made where the
      // project lives leaves nothing to hold, so the task closes as merged
      // without a put-in (FI3-213).
      if (held && mode === "merge-pr") {
        const pull = await this.mergedOutside(record);
        if (pull) return this.closeMergedOutside(taskId, actor, pull);
      }
      if (held) return { ok: false, text: held.text, refusal: held };
    }
    if (mode === "merge-pr") {
      return this.mergePrTaskOnce(taskId, actor, guard, boundary);
    }
    if (mode === "land") {
      return this.landTaskOnce(taskId, actor, boundary);
    }

    if (
      (record.status === "done" || record.status === "dropped") &&
      !(record.worktreeDir && record.workspaceState === "present")
    ) {
      return {
        ok: false,
        text: `Task ${taskId} "${record.title}" is already ${describeStatus(record)}; there is nothing to discard.`,
      };
    }
    if (this.working(taskId) && !confirm) {
      return {
        ok: false,
        text: `Cannot discard task ${taskId} "${record.title}" while it is still working. Interrupt it first, or pass confirm true after the captain chooses.`,
      };
    }
    // On a computer that runs work, that computer reads its own working
    // copy; while it is out of reach nobody can say it holds nothing.
    const work = record.deviceId
      ? await (this.host.placed?.workStatus(taskId) ?? Promise.resolve(null))
      : await this.host.workspace
          .taskWorkStatus({
            taskId,
            cwd: record.worktreeDir,
            branch: record.branch,
            repoDir: record.repoDir,
          })
          .catch(() => ({ dirty: false, unlandedCommits: 0 }));
    if (!work && !confirm && record.workspaceState === "present") {
      const refusal = this.unreadableWorkRefusal(record);
      return { ok: false, text: refusal.text, refusal };
    }
    if (work && (work.dirty || work.unlandedCommits > 0) && !confirm) {
      const refusal = this.unlandedWorkRefusal(record, work);
      return { ok: false, text: refusal.text, refusal };
    }
    const prResult = await this.closeOpenPullRequest(taskId, { line: actor === "firstmate" });
    const problem = prResult.problem;
    await this.closeTask(taskId, { status: "dropped", reason: "discarded", actor });
    return {
      ok: true,
      text: discardedText(record.title, prResult.text),
      ...(problem ? { problem } : {}),
      ...(prResult.repair ? { followup: prResult.repair } : {}),
    };
  }

  /**
   * Best effort for every abandoned attempt; never prevent local cleanup.
   * A pull request it could not close is not left with nobody on it
   * (INF-549's sibling): the host files the task that closes it, and the
   * note says so - on the feed too, unless the captain's own click already
   * puts the outcome there (`line`).
   */
  async closeOpenPullRequest(
    taskId: string,
    options: { line?: boolean } = {},
  ): Promise<PrOutcome & { repair?: string }> {
    if (this.host.taskDelivery(taskId) !== "direct-pr" || !this.host.closePullRequest) {
      return { ok: true, text: "" };
    }
    const result = await this.host.closePullRequest(taskId).catch((caught): PrOutcome => {
      const message = caught instanceof Error ? caught.message : String(caught);
      return { ok: false, text: `Could not close its PR: ${message}`, problem: message };
    });
    const record = this.host.tasks.get(taskId);
    let repair: { record: TaskRecord; filed: boolean } | undefined;
    if (!result.ok && record?.delivery?.prNumber !== undefined) {
      try {
        repair = this.host.filePullRepair?.(record, result.problem);
      } catch (caught) {
        console.warn("[settle] the pull request repair could not be filed:", caught);
      }
    }
    const said = repair
      ? pullLeftOpenText({ key: repair.record.key || repair.record.id, filed: repair.filed })
      : undefined;
    const text = said ? `${result.text} ${said}` : result.text;
    // The record's line says what it means; the raw words ride its data
    // and the tool's answer, as every settle failure's do.
    const line = said
      ? `Its pull request is still open where the project lives: ${plainProblem(result.problem ?? result.text)}. ${said}`
      : text;
    if (line && record) {
      this.host.tasks.note(taskId, line, {
        news: true,
        ...(repair && options.line !== false ? { feed: true } : {}),
        ...(result.problem || repair
          ? {
              data: {
                ...(result.problem ? { problem: result.problem } : {}),
                ...(repair ? { feedLine: true, pullRepair: repair.record.id } : {}),
              },
            }
          : {}),
        ...(repair ? { about: [repair.record.id] } : {}),
      });
    }
    return { ...result, text, ...(said ? { repair: said } : {}) };
  }

  /**
   * A user-initiated discard from a leftover task card (and the shell's
   * inf:task:delete, which behaves like discard). Its outcome must outlive
   * the surface that requested it, exactly like the other card settles.
   */
  async requestDiscard(taskId: string): Promise<void> {
    if (!this.host.tasks.get(taskId)) return;
    await this.reportCardSettle(taskId, "discard");
  }

  /** Every detached settle is awaited here; refusal text is an outcome too. */
  async reportCardSettle(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm?: boolean,
    proceedWithOpen?: boolean,
  ): Promise<void> {
    const title = this.host.tasks.get(taskId)?.title ?? taskId;
    if (!this.settlingTasks.has(taskId)) {
      const waitsForTurn = (mode === "merge-pr" || mode === "land") && this.working(taskId);
      const action =
        mode === "merge-pr"
          ? "Putting the change in"
          : mode === "land"
            ? "Putting the work in"
            : "Discarding";
      this.host.broadcastEvent({
        type: "firstmate_note",
        text: waitsForTurn
          ? `${action} for "${title}" is queued and will run when the crewmate finishes what it is doing.`
          : `${action} for "${title}" - the result will appear here.`,
      });
    }
    // The click's own approval, minted with its card resolution (FI3-304):
    // this attempt merges only the head that approval covers.
    const authorization =
      mode === "merge-pr"
        ? standingAuthorization(this.host.tasks.get(taskId)?.delivery)
        : undefined;
    if (authorization) await this.storeApprovalReading(taskId, authorization);
    let result: SettleOutcome;
    try {
      result = await this.settleTaskGuarded(
        taskId,
        mode,
        confirm,
        "captain",
        proceedWithOpen ?? authorization?.proceedWithOpen ?? false,
        authorization ? this.guardOf(taskId, authorization, false) : undefined,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      result = {
        ok: false,
        text: `Could not complete ${mode} for task ${taskId}: ${message}`,
        problem: message,
      };
    }
    // A refusal that is not a verdict on the approved work does not spend
    // the captain's click: his approval stands on the task and the host
    // runs it once the gates pass (FI3-304).
    const kept = authorization ? this.afterAttempt(taskId, authorization, result) : undefined;
    if (kept) {
      const place = this.placeOf(this.host.tasks.get(taskId));
      result = { ...result, text: `${result.text}\n\n${keptNote(kept.wait, kept.head, place)}` };
    }
    this.reportOutcome(taskId, title, mode, confirm, result, kept?.wait);
  }

  /**
   * Mint the captain's merge approval for the offer he clicked (FI3-304),
   * inside the card resolution's transaction and before any work starts.
   * It is minted only on a GitHub direct-pr task, for an offer the host
   * published after its checks passed at a known head, on the pull request
   * the task still names; anything else - a seeded or Firstmate card, an
   * offer with no baseline, a plain Git host - approves no head and the
   * click is one attempt, as before. A standing approval the click
   * replaces is superseded either way.
   */
  authorizeMerge(
    taskId: string,
    approval: MergeApproval,
    proceedWithOpen: boolean,
    reviewId?: string,
  ): void {
    const record = this.host.tasks.get(taskId);
    if (!record || TaskService.isClosed(record)) return;
    const now = this.host.now();
    const previous = record.delivery?.mergeAuthorization;
    const generation = (previous?.generation ?? 0) + 1;
    const minted = this.mint(record, approval, proceedWithOpen, generation, now, reviewId);
    if (minted) {
      this.host.tasks.recordPermissionRecords(taskId, {
        mergeAuthorization: minted,
        ...(minted.review?.relationship === "referenced" ? { checkTarget: minted.review } : {}),
      });
      this.host.tasks.note(
        taskId,
        `The captain approved merging ${this.changeName(record, minted.target.prNumber)} at ${minted.approvedHead}.`,
        { news: true, data: { mergeAuthorization: minted.id, generation } },
      );
      return;
    }
    if (previous?.status === "standing") {
      this.endAuthorization(taskId, "superseded", "the captain clicked merge on another card");
    }
  }

  private mint(
    record: TaskRecord,
    approval: MergeApproval,
    proceedWithOpen: boolean,
    generation: number,
    now: number,
    reviewId?: string,
  ): MergeAuthorization | undefined {
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    const review = reviewId
      ? record.delivery?.mergeReviews?.find((item) => item.id === reviewId)
      : undefined;
    const location = repo ? forgeLocationOf(repo) : undefined;
    // A request review is a typed, head-bound offer. Rule-skipping clicks remain one-shot.
    if (
      reviewId &&
      (this.host.taskDelivery(record.id) !== "direct-pr" ||
        !review ||
        review.skips ||
        review.receipt ||
        location?.host !== review.host ||
        location.owner !== review.owner ||
        location.name !== review.name)
    )
      return undefined;
    const offer = review
      ? { baseline: { headSha: review.headSha, prNumber: review.number }, ...review }
      : approvableOffer(record, repo, this.host.taskDelivery(record.id), approval);
    const offerId = approval.offerId;
    if (!offer || !offerId || !record.repoId || !record.branch) return undefined;
    const { baseline } = offer;
    return {
      version: 1,
      id: randomUUID(),
      generation,
      issuer: "captain",
      at: now,
      card: {
        id: approval.cardId,
        ...(approval.lifecycleId ? { lifecycleId: approval.lifecycleId } : {}),
        offerId,
        actionId: approval.actionId,
        ...(approval.interactionId ? { interactionId: approval.interactionId } : {}),
      },
      target: {
        repoId: record.repoId,
        host: offer.host,
        owner: offer.owner,
        name: offer.name,
        prNumber: baseline.prNumber,
        branch: review?.branch ?? record.branch,
        delivery: "direct-pr",
        method: "squash",
      },
      ...(review ? { review } : {}),
      approvedHead: baseline.headSha,
      ...(record.delivery?.versionReadings?.[baseline.headSha]
        ? { changeReading: record.delivery.versionReadings[baseline.headSha] }
        : {}),
      lineage: [],
      proceedWithOpen,
      status: "standing",
    };
  }

  /** Patch the standing approval, if one stands. */
  private patchStanding(taskId: string, patch: Partial<MergeAuthorization>): void {
    const record = this.host.tasks.get(taskId);
    const authorization = standingAuthorization(record?.delivery);
    if (!record || !authorization) return;
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: { ...authorization, ...patch },
    });
  }

  /** The merge happened under the standing approval: it is spent. */
  private consumeStanding(taskId: string, receipt: PrOutcome["receipt"]): void {
    const now = this.host.now();
    this.patchStanding(taskId, {
      status: "consumed",
      endedAt: now,
      attempt: undefined,
      retryAt: undefined,
      waiting: undefined,
      ...(receipt
        ? {
            receipt: { head: receipt.head, ...(receipt.sha ? { sha: receipt.sha } : {}), at: now },
          }
        : {}),
    });
  }

  /**
   * End the standing approval (FI3-304 section 6): `revoked` by an
   * interruption or the captain's withdrawal, `invalidated` when the
   * approved work or pull request is no longer the one he approved,
   * `superseded` by a new completion card or click. The generation
   * advances, so a run already under way stops before it sends anything.
   * A revoked or work-changed end holds the task's merge for the captain.
   */
  endAuthorization(
    taskId: string,
    status: "revoked" | "invalidated" | "superseded",
    why: string,
    options: { holds?: boolean; feed?: boolean } = {},
  ): boolean {
    const record = this.host.tasks.get(taskId);
    const authorization = standingAuthorization(record?.delivery);
    if (!record || !authorization) return false;
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...authorization,
        status,
        reason: why,
        endedAt: this.host.now(),
        generation: authorization.generation + 1,
        ...(options.holds ? { holds: true } : {}),
        attempt: undefined,
        retryAt: undefined,
        waiting: undefined,
      },
    });
    if (!TaskService.isClosed(record)) {
      this.host.tasks.note(taskId, `The captain's kept merge approval ended: ${why}.`, {
        news: true,
        feed: options.feed ?? false,
      });
    }
    return true;
  }

  /** The captain's or the Firstmate's interruption withdraws the approval (interrupt = revoke). */
  revokeMergeAuthorization(taskId: string, why: string): boolean {
    return this.endAuthorization(taskId, "revoked", why, { holds: true, feed: true });
  }

  /**
   * The captain's guidance reached the task while his approval stands
   * (FI3-662): it takes the next mark, which rides the message to the
   * crewmate, and the merge holds until the crewmate declares that mark's
   * impact. Called as the steer's row is recorded, so guidance nothing
   * could deliver holds nothing. Undefined when no approval stands.
   */
  holdForGuidance(taskId: string): number | undefined {
    const record = this.host.tasks.get(taskId);
    const authorization = standingAuthorization(record?.delivery);
    if (!record || !authorization || TaskService.isClosed(record)) return undefined;
    const now = this.host.now();
    const before = authorization.guidance ?? { latest: 0, declared: 0, at: now };
    const mark = before.latest + 1;
    const began = outstandingGuidance(authorization) === undefined;
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: { ...authorization, guidance: { ...before, latest: mark, at: now } },
    });
    this.host.tasks.note(
      taskId,
      `The captain's guidance (mark ${mark}) holds the kept merge until its crewmate declares its impact.`,
      { news: true, data: { mergeGuidance: { mark } } },
    );
    if (began) {
      this.host.broadcastEvent({
        type: "firstmate_note",
        text: `Your merge of "${record.title}" is kept and waits until its crewmate says whether your newer words change the work you approved.`,
        taskId,
      });
    }
    return mark;
  }

  /**
   * The guard a merge under the approval runs with: its candidate head and
   * pinned pull request, and the last look right before the request goes
   * out - the same approval, the same generation and head, the crewmate
   * idle, no new completion card - which persists the attempt token the
   * restart reconcile reads (FI3-304 section 5).
   */
  private guardOf(taskId: string, authorization: MergeAuthorization, unattended: boolean) {
    const head = candidateHead(authorization);
    const guard: MergeGuard = {
      head,
      prNumber: authorization.target.prNumber,
      unattended,
      // The captain's guidance since his click holds the merge without
      // spending the approval, read right before the last look (FI3-662).
      held: () => {
        const now = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
        const mark = now?.id === authorization.id ? outstandingGuidance(now) : undefined;
        return mark === undefined
          ? undefined
          : `the captain's guidance (mark ${mark}) waits for its crewmate to declare its impact`;
      },
      beforeDispatch: (dispatchHead) => {
        const record = this.host.tasks.get(taskId);
        const now = standingAuthorization(record?.delivery);
        if (!record || TaskService.isClosed(record)) return "the task closed";
        if (now?.id !== authorization.id || now.generation !== authorization.generation) {
          return "the captain's merge approval ended";
        }
        const identity = this.authorizationIdentity(record, now);
        if (identity) {
          this.endAuthorization(taskId, "invalidated", identity, { feed: true });
          return identity;
        }
        if (candidateHead(now) !== dispatchHead || dispatchHead !== head) {
          return "the pull request is not at the version the approval covers";
        }
        if (unattended && this.working(taskId)) return "its crewmate started working again";
        if (unattended && this.host.cards.openMergeAction(taskId)) {
          return "a new completion card is up";
        }
        this.host.tasks.recordPermissionRecords(taskId, {
          mergeAuthorization: {
            ...now,
            attempt: { token: randomUUID(), head: dispatchHead, at: this.host.now() },
          },
        });
        return undefined;
      },
    };
    return guard;
  }

  /**
   * What an attempt's outcome does to the approval it ran under: a merge
   * already spent it; a pull request closed or swapped ends it; every
   * other stop leaves it standing, waiting on that stop - with a time to
   * look again where nothing else will wake it. Returns the wait and
   * whether it is new, or undefined when the approval no longer stands.
   */
  private afterAttempt(
    taskId: string,
    authorization: MergeAuthorization,
    result: SettleOutcome,
  ): { wait: MergeWait; head: string; changed: boolean } | undefined {
    const record = this.host.tasks.get(taskId);
    const current = standingAuthorization(record?.delivery);
    if (!record || !current || current.id !== authorization.id || result.ok) return undefined;
    if (result.stop === "withdrawn") return undefined;
    const now = this.host.now();
    if (result.contention) {
      this.patchStanding(taskId, { retryAt: now });
      return undefined;
    }
    if (result.stop === "closed" || result.stop === "identity") {
      this.endAuthorization(
        taskId,
        "invalidated",
        result.stop === "closed"
          ? "its pull request was closed without merging"
          : "the branch's pull request is not the one approved",
        { feed: true },
      );
      return undefined;
    }
    const wait = waitOf(result, current.undecided !== undefined);
    const head = candidateHead(current);
    const changed = current.waiting?.on !== wait || current.waiting.head !== head;
    const retries = changed ? 0 : (current.retries ?? 0) + 1;
    const retryAt = retryAfter(wait, retries, now);
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...current,
        waiting: { on: wait, head, at: now },
        retries,
        retryAt,
        ...(result.stop === "outcome" ? {} : { attempt: undefined }),
      },
    });
    return { wait, head, changed };
  }

  /**
   * The checks a host-run merge makes before it asks anything of GitHub
   * (FI3-304 section 4): the task and pull request are still the approved
   * ones, no new completion card replaced the approval, no round cap holds
   * the task, a declared repair is not still undecided, and a reviewed
   * task's review passed for this change. A failed identity
   * check ends the approval; the others are waits.
   */
  private authorizationIdentity(
    record: TaskRecord,
    authorization: MergeAuthorization,
  ): string | undefined {
    const target = authorization.target;
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    const location = repo ? forgeLocationOf(repo) : undefined;
    return this.host.taskDelivery(record.id) !== "direct-pr"
      ? "the project no longer delivers as a pull request"
      : record.repoId !== target.repoId || !repo
        ? "the task's project is no longer the one approved"
        : !hasChangeRequests(repo.host?.kind) ||
            location?.host !== target.host ||
            location.owner !== target.owner ||
            location.name !== target.name
          ? "where the project lives changed"
          : authorization.review?.relationship === "referenced"
            ? record.delivery?.checkTarget?.number !== target.prNumber ||
              record.delivery.checkTarget.branch !== target.branch
              ? "the task's selected pull request is not the one approved"
              : undefined
            : record.branch !== target.branch || record.delivery?.prNumber !== target.prNumber
              ? "the task's pull request is not the one approved"
              : undefined;
  }

  private preflight(
    record: TaskRecord,
    authorization: MergeAuthorization,
  ): { ended: true } | { wait: MergeWait } | undefined {
    const identity = this.authorizationIdentity(record, authorization);
    if (identity) {
      this.endAuthorization(record.id, "invalidated", identity, { feed: true });
      return { ended: true };
    }
    if (this.host.cards.openMergeAction(record.id)) {
      this.endAuthorization(record.id, "superseded", "its crewmate put up a new completion card");
      return { ended: true };
    }
    if (standingCap(record.delivery)) return { wait: "cap" };
    if (outstandingGuidance(authorization) !== undefined) return { wait: "guidance" };
    if (authorization.undecided) {
      // Its crewmate could not judge the repair: one independent assessment
      // decides it. An end it brings tells the crewmate itself, so the wait
      // below then records nothing.
      this.host.assessRepair?.(record.id);
      return { wait: "evidence" };
    }
    const head = candidateHead(authorization);
    if (
      this.policiesOf(record)?.rigor.value === "reviewed" &&
      ((!reviewCoversHead(record.delivery, head) &&
        !overridePasses(record.delivery, "review", head)) ||
        (!acceptedValidation(record.delivery?.liveValidation, head).ready &&
          !overridePasses(record.delivery, "live-proof", head)))
    ) {
      return { wait: "review" };
    }
    return undefined;
  }

  /**
   * Store the approved head's change reading on the approval (INF-416 G).
   * The click is the moment that version enters the record. A later kept
   * merge compares this stored fact and does not read the branch again.
   * An unreadable commit stores nothing.
   */
  private async storeApprovalReading(
    taskId: string,
    authorization: MergeAuthorization,
  ): Promise<void> {
    if (authorization.changeReading) return;
    const record = this.host.tasks.get(taskId);
    if (!record || this.policiesOf(record)?.rigor.value !== "reviewed") return;
    const read = this.host.workspace.reviewChangeReading;
    if (typeof read !== "function") return;
    try {
      const home = record.deviceId ? await this.host.placed?.bringBranchHome(taskId) : undefined;
      const fresh = this.host.tasks.get(taskId) ?? record;
      const repo = fresh.repoId ? this.host.repos.get(fresh.repoId) : undefined;
      const dir = home ?? repo?.path ?? fresh.repoDir;
      if (!dir) return;
      const reading = await read.call(this.host.workspace, dir, authorization.approvedHead);
      if (!reading) return;
      const current = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
      if (
        !current ||
        current.id !== authorization.id ||
        current.approvedHead !== authorization.approvedHead ||
        current.changeReading
      ) {
        return;
      }
      const delivery = this.host.tasks.get(taskId)?.delivery;
      this.host.tasks.recordApprovedChangeReading(taskId, {
        mergeAuthorization: { ...current, changeReading: reading },
        versionReadings: { ...delivery?.versionReadings, [authorization.approvedHead]: reading },
      });
    } catch {
      // An unreadable version stores nothing. Coverage then waits on review.
    }
  }

  /**
   * Run the standing approval once, as the host on the captain's behalf: at
   * every crewmate idle boundary, on the tick when a timed wait comes due,
   * and at boot. It merges only the candidate head, only after the
   * preflight, GitHub's own readiness, every page of the checks and the
   * last look before the request; what stops it is a wait on the approval
   * (a quiet timeline line, and one wake where someone else must move) or
   * an end that the feed and the Firstmate hear.
   * A reviewed task's coverage is the reading stored with the candidate
   * version. This run does not read the branch to carry a passed review.
   */
  async runMergeAuthorization(taskId: string): Promise<void> {
    const record = this.host.tasks.get(taskId);
    const authorization = standingAuthorization(record?.delivery);
    if (!record || !authorization || TaskService.isClosed(record)) return;
    if (this.settlingTasks.has(taskId) || record.pendingSettle || this.working(taskId)) return;
    if (authorization.attempt) {
      await this.reconcileAttempt(taskId, authorization);
      return;
    }
    const title = record.title;
    const checked = this.preflight(this.host.tasks.get(taskId) ?? record, authorization);
    if (checked && "ended" in checked) {
      this.reportEnded(taskId, title);
      return;
    }
    if (checked) {
      const wait = this.markWaiting(taskId, checked.wait);
      if (wait?.changed) {
        this.noteWait(
          taskId,
          title,
          wait.head,
          {
            ok: false,
            text: keptFeedLine(
              title,
              checked.wait,
              this.placeOf(record),
              this.host.tasks.get(taskId)?.delivery?.ci,
            ),
          },
          checked.wait,
        );
      }
      return;
    }
    if (authorization.review) {
      const result = await this.requestMerge(taskId, authorization.review.id, true);
      if (!result.ok && !standingAuthorization(this.host.tasks.get(taskId)?.delivery))
        this.reportEnded(taskId, title, result);
      return;
    }
    let result: SettleOutcome;
    try {
      result = await this.settleTaskGuarded(
        taskId,
        "merge-pr",
        undefined,
        "captain",
        authorization.proceedWithOpen,
        this.guardOf(taskId, authorization, true),
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      result = {
        ok: false,
        text: `Could not complete merge-pr for task ${taskId}: ${message}`,
        problem: message,
      };
    }
    if (result.contention) return;
    if (result.ok) {
      this.reportOutcome(taskId, title, "merge-pr", undefined, result, undefined);
      return;
    }
    const kept = this.afterAttempt(taskId, authorization, result);
    if (!kept) {
      if (result.stop !== "withdrawn") this.reportEnded(taskId, title, result);
      return;
    }
    if (kept.changed) this.noteWait(taskId, title, kept.head, result, kept.wait);
  }

  /** Record a preflight wait on the standing approval; whether it is new for this head. */
  private markWaiting(
    taskId: string,
    wait: MergeWait,
  ): { head: string; changed: boolean } | undefined {
    const current = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
    if (!current) return undefined;
    const head = candidateHead(current);
    const now = this.host.now();
    const changed = current.waiting?.on !== wait || current.waiting.head !== head;
    const retries = changed ? 0 : (current.retries ?? 0) + 1;
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...current,
        waiting: { on: wait, head, at: now },
        retries,
        retryAt: retryAfter(wait, retries, now),
      },
    });
    return { head, changed };
  }

  /**
   * A wait that is new for this head: a quiet line on the task's timeline
   * with the raw words, and one wake to the Firstmate when someone other
   * than the crewmate the check watch already wakes has to move.
   */
  private noteWait(
    taskId: string,
    title: string,
    head: string,
    result: SettleOutcome,
    wait: MergeWait,
  ): void {
    this.host.tasks.note(taskId, `The kept merge did not run yet: ${result.text}`, {
      news: true,
      ...(result.problem || result.plain
        ? { data: { problem: result.problem ?? result.plain } }
        : {}),
    });
    if (!wakesFirstmate(wait)) return;
    const record = this.host.tasks.get(taskId);
    const place = this.placeOf(record);
    this.host.broadcastEvent({
      type: "firstmate_note",
      text: keptFeedLine(title, wait, place, record?.delivery?.ci),
    });
    this.wakeOnSettle(taskId, title, "merge-pr (kept)", {
      ...result,
      text: `${result.text}\n\n${keptNote(wait, head, place)}${wait === "review" && record ? ` ${acceptedValidation(record.delivery?.liveValidation, head).reason}${this.host.tasks.briefContains(record.id, CAREFUL_LIVE_VALIDATION) ? "" : ` Relay this missing contract to the builder: ${CAREFUL_LIVE_VALIDATION}`}` : ""}`,
    });
  }

  /**
   * The approval ended on a host-run attempt: the Firstmate hears why. A
   * new completion card superseding it needs no word - the card is up.
   */
  private reportEnded(taskId: string, title: string, result?: SettleOutcome): void {
    const ended = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
    if (ended?.status === "superseded") return;
    const reason = ended?.reason;
    const text = `The captain's kept merge approval for "${title}" ended: ${reason ?? "it no longer stands"}. A new completion card is the way to merge it.`;
    this.wakeOnSettle(taskId, title, "merge-pr (kept)", {
      ok: false,
      text: result ? `${result.text}\n\n${text}` : text,
    });
  }

  /**
   * An attempt token outlived its answer - the app quit or the answer
   * never came (FI3-304 section 5). The pinned pull request decides: merged
   * means the approval is spent and the task closes once; closed ends it;
   * open at the same head clears the token and runs every gate again; an
   * unreadable one waits.
   */
  private async reconcileAttempt(taskId: string, authorization: MergeAuthorization): Promise<void> {
    const readPull = this.host.readPull;
    let pull: ForgePull | undefined;
    try {
      pull = readPull ? await readPull(taskId, authorization.target.prNumber) : undefined;
    } catch {
      pull = undefined;
    }
    const record = this.host.tasks.get(taskId);
    const current = standingAuthorization(record?.delivery);
    if (
      !record ||
      current?.id !== authorization.id ||
      current.generation !== authorization.generation
    ) {
      return;
    }
    const now = this.host.now();
    if (!pull) {
      const retries = (current.retries ?? 0) + 1;
      this.patchStanding(taskId, {
        waiting: { on: "outcome", head: candidateHead(current), at: now },
        retries,
        retryAt: retryAfter("outcome", retries, now),
      });
      return;
    }
    if (pull.merged) {
      await this.finishMerged(taskId, record.title, pull);
      return;
    }
    if (pull.state !== "open") {
      this.endAuthorization(taskId, "invalidated", "its pull request was closed without merging", {
        feed: true,
      });
      this.reportEnded(taskId, record.title);
      return;
    }
    this.patchStanding(taskId, { attempt: undefined, retryAt: now });
    await this.runMergeAuthorization(taskId);
  }

  /** A merge the reconcile found already done: spend the approval and close the task once. */
  private async finishMerged(taskId: string, title: string, pull: ForgePull): Promise<void> {
    if (this.settlingTasks.has(taskId)) return;
    this.settlingTasks.set(taskId, "merge-pr");
    try {
      const authorization = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
      if (authorization?.review?.relationship === "referenced") {
        this.finishReferenced(taskId, authorization.review, {
          ok: true,
          text: `Merged ${this.changeName(this.host.tasks.get(taskId), pull.number)} on ${this.placeOf(this.host.tasks.get(taskId))}. The task stays open.`,
          receipt: {
            head: pull.headSha,
            ...(pull.mergedSha ? { sha: pull.mergedSha } : {}),
            already: true,
          },
        });
        return;
      }
      this.consumeStanding(taskId, {
        head: pull.headSha,
        ...(pull.mergedSha ? { sha: pull.mergedSha } : {}),
        already: true,
      });
      const record = this.host.tasks.get(taskId);
      const text = `Merged ${this.changeName(record, pull.number)} on ${this.placeOf(record)}.`;
      await this.closeTask(taskId, {
        status: "done",
        reason: "merged",
        actor: "captain",
        text,
        delivery: { landedMode: "pr" },
      });
      this.reportOutcome(taskId, title, "merge-pr", undefined, { ok: true, text }, undefined);
    } finally {
      this.settlingTasks.delete(taskId);
      this.sentMerges.delete(taskId);
    }
  }

  /**
   * The tick's rider: every standing approval whose timed wait came due
   * runs again (FI3-304: persisted delayed reconciliation, never a hot loop
   * that a restart resets).
   */
  reconcileMergeAuthorizations(now: number): void {
    for (const record of this.host.tasks.listLive()) {
      const authorization = standingAuthorization(record.delivery);
      if (!authorization || authorization.retryAt === undefined || authorization.retryAt > now) {
        continue;
      }
      void this.runMergeAuthorization(record.id).catch((caught: unknown) => {
        console.warn("[settle] a kept merge approval could not run:", caught);
      });
    }
  }

  /**
   * At boot: contract 4.66's unversioned kept click names no approved head,
   * so it is retired and said, never carried forward; every standing
   * approval runs once - an attempt token first reads its pull request back.
   */
  resumeMergeAuthorizations(): void {
    for (const record of this.host.tasks.listLive()) {
      if (record.delivery?.mergeOrder) {
        this.host.tasks.recordPermissionRecords(record.id, { mergeOrder: undefined });
        const text = `The kept merge click for "${record.title}" was made before this version and names no approved version, so it could not be carried forward. Its crewmate puts up its completion card again once the checks pass.`;
        this.host.tasks.note(record.id, text, { news: true, feed: true });
        this.wakeOnSettle(record.id, record.title, "merge-pr (kept before this version)", {
          ok: false,
          text,
        });
      }
      if (!standingAuthorization(record.delivery)) continue;
      void this.runMergeAuthorization(record.id).catch((caught: unknown) => {
        console.warn("[settle] a kept merge approval could not resume:", caught);
      });
    }
  }

  /** The feed's receipt of a settle and the wake that makes a refusal actionable. */
  private reportOutcome(
    taskId: string,
    title: string,
    mode: "merge-pr" | "land" | "discard",
    confirm: boolean | undefined,
    result: SettleOutcome,
    kept: MergeWait | undefined,
  ): void {
    // The persistent feed is always a receipt of the outcome; the wake below
    // is what makes a refusal actionable. The card that triggered this
    // already vanished on click (instant acknowledgement), and the host
    // raises no retry card of its own (cards/tasks/agents P0, WI-3): a retry
    // is the Firstmate re-settling, or a decision card it emits. A raw
    // failure never reaches the feed (the vocabulary's error row): the line
    // says what it means, the raw text is kept on the task's timeline one
    // click deeper, and the wake carries it verbatim for the Firstmate.
    this.recordRefusal(taskId, mode, result);
    this.host.broadcastEvent({
      type: "firstmate_note",
      text: kept
        ? keptFeedLine(
            title,
            kept,
            this.placeOf(this.host.tasks.get(taskId)),
            this.host.tasks.get(taskId)?.delivery?.ci,
          )
        : settleFeedLine(title, mode, result),
    });
    // A merge that went through is the feed line above and nothing more,
    // unless it freed work only a start begins (friction 7 of the
    // captain's Oct 22 audit: 45 of 62 merge wakes were idle turns).
    if (result.ok && mode !== "discard" && !this.freesWorkAwaitingStart(taskId)) return;
    this.wakeOnSettle(taskId, title, confirm ? `${mode} (confirmed)` : mode, {
      ...result,
      text: result.text + this.missingValidationBrief(taskId, mode, result),
    });
  }

  /**
   * Whether this merged task held open work that now waits on nothing and
   * that the ready sweep will not start - on request, or held by a gate
   * (`TaskService.awaitsStart`). Only the Firstmate or the captain begins
   * it, and a task the Firstmate linked to wait on this merge - one its
   * report says it covers - is such work, so its after-merge check runs.
   * An active waiter needs no wake: the ready sweep steers it when this
   * task closes (`dependency-closed`).
   */
  private freesWorkAwaitingStart(taskId: string): boolean {
    const tasks = this.host.tasks;
    return tasks
      .blocking(taskId)
      .some(
        (record) =>
          record.status === "open" &&
          tasks.waitingOn(record.id).length === 0 &&
          tasks.awaitsStart(record),
      );
  }

  /**
   * A host-owned settle the captain triggered - a card's land, merge-pr or
   * discard, and the shell's delete - comes back to the Firstmate as a
   * wake, exactly as a declared card choice would. The host answered on the
   * agent's behalf, so the agent hears the answer.
   *
   * Every refusal and failure wakes, and every discard: there is
   * deliberately no branch sorting the orchestratable ones from the rest,
   * because that classification is what broke this path - a discard
   * refused for want of `confirm` reads "call again with confirm true
   * after the captain chooses", an instruction that reached only the feed,
   * so no one could act on it. A merge or land that went through wakes
   * only when it freed work that only a start begins
   * (`freesWorkAwaitingStart`); any other success is its feed line alone.
   *
   * Three things this must get right:
   * - It runs only once the settle has fully resolved and after any close
   *   purge, so its task ref survives while anchoring the consuming decision.
   * - Only host-initiated settles come through here. Firstmate's own
   *   settle_task receives this same text as its tool result, so waking
   *   there too would deliver it twice.
   * - Contention is not an outcome (see SettleOutcome): nothing was
   *   settled, and the attempt that owns the task reports its own result.
   *   Waking here would announce a settle that never ran.
   *
   * A structured refusal (WI-12) rides the wake as its prose plus a fenced
   * JSON block, so the Firstmate can answer with one card whose actions
   * carry the `ways` as effects. The feed line stays the prose alone.
   */
  private wakeOnSettle(taskId: string, title: string, chose: string, result: SettleOutcome): void {
    if (result.contention) return;
    this.host.notifyOp(
      {
        facts: {
          kind: "settled",
          task: { id: taskId, title },
          chose,
          outcome: result.text,
          ...(result.refusal ? { refusal: result.refusal } : {}),
        },
      },
      "agent",
      taskId,
    );
  }

  /**
   * Settle a task: the crewmate stops, the worktree and branch go, the
   * lane and open cards retire, and the RECORD CLOSES - its row, timeline
   * and session JSONL under crewmates/<taskId> stay (captain decision D2:
   * "the sessions are very valuable ... we shouldn't remove the entire
   * session JSONL altogether"). The worktree vanishing is the externally
   * observable "settled" signal (the phase3 e2e polls for it), so the
   * record closes before it goes.
   */
  async closeTask(
    taskId: string,
    close: TaskClose,
    options: { recordBeforeStop?: boolean } = {},
  ): Promise<void> {
    // The close reaches its crewmate, which leaves once the spark lands; a
    // superseded one hands over to its successor, whose start is its spark.
    if (close.reason !== "superseded") this.host.announceReach?.(taskId);
    this.host.killJobs?.(taskId);
    this.host.endLiveTask(taskId);
    const stopping = this.host.stopRuntime(taskId);
    if (stopping && !options.recordBeforeStop) {
      await stopping;
      this.releaseSettleBoundary(taskId);
    }
    const record = this.host.tasks.get(taskId);
    // The lane and every queued wake retire with the task, in the close's
    // own transaction: a settled task makes still-recorded guidance moot.
    // A row already done or dropped keeps its close; a discard there only
    // clears the worktree it kept (WI-7).
    let answerHandoffQueued = false;
    let sentence: string | undefined;
    if (record && record.status !== "done" && record.status !== "dropped") {
      sentence = this.takeClosingSentence(taskId, close.actor);
      const data =
        close.data || close.answerHandoff || sentence
          ? {
              ...close.data,
              ...(close.answerHandoff ? { choice: close.answerHandoff.choice.label } : {}),
              ...(sentence ? { closingSentence: sentence } : {}),
            }
          : undefined;
      this.closeAndPurge([taskId], () => {
        // A standing approval ends with its task: spent by a merge, revoked
        // by any other close (FI3-304), in the close's own transaction.
        const standing = standingAuthorization(record.delivery);
        if (standing) {
          this.host.tasks.recordPermissionRecords(taskId, {
            mergeAuthorization: {
              ...standing,
              status: close.reason === "merged" ? "consumed" : "revoked",
              reason: `the task closed ${close.reason}`,
              endedAt: this.host.now(),
              generation: standing.generation + 1,
              attempt: undefined,
              retryAt: undefined,
              waiting: undefined,
            },
          });
        }
        this.host.tasks.close(taskId, {
          status: close.status,
          reason: close.reason,
          actor: close.actor,
          ...(close.text ? { text: close.text } : {}),
          ...(close.delivery ? { delivery: close.delivery } : {}),
          ...(close.feed === false ? { feed: false } : {}),
          // The captain's choice on an answer's card is a fact of the
          // close, so work built on the answer can be told what was chosen;
          // so is the first mate's sentence on a close of its own.
          ...(data ? { data } : {}),
        });
        if (close.answerHandoff) {
          answerHandoffQueued =
            this.host.inbox.enqueueWake(
              FIRSTMATE_RECIPIENT,
              { facts: { kind: "answer-closed", handoff: close.answerHandoff } },
              "agent",
              taskId,
            ) !== null;
        }
      });
    } else {
      this.host.inbox.purgeTask(taskId);
    }
    // External observation closes at the synchronous idle boundary, before
    // stopping can yield: new guidance must see a closed record, not be purged
    // later after it was accepted on a task that still appeared open.
    if (stopping && options.recordBeforeStop) {
      await stopping;
      this.releaseSettleBoundary(taskId);
    }
    // The durable handoff becomes visible only after its close transaction;
    // poking here cannot race the lane purge that precedes its insertion.
    if (answerHandoffQueued) this.host.pokeInbox();
    this.host.cards.retireTaskCards(taskId, close.reason, { keepNotes: close.status === "done" });
    if (record && close.reason === "merged") this.finishMergeNote(record, close.actor, sentence);
    if (record && sentence) this.leaveClosingNote(record, close.reason, sentence);
    this.host.cards.scheduleBroadcast();
    this.host.broadcastCrewCounts();
    if (record?.worktreeDir && record.workspaceState !== "removed") {
      // A confirmed discard is the captain choosing to throw the work away:
      // it is still saved when it can be, but a failed save never keeps it.
      await this.retireWorktreeOf(record, { force: close.reason === "discarded" });
    }
    // Delivery machinery follows its parent out, whatever the direction
    // the parent closed in - a review must never outlive its builder.
    await this.retireDeliveryChildren(taskId, record?.title);
    // Any close may release a row waiting on this task, or leave one
    // waiting forever (the ready query and the dead-blocker card, P2).
    void this.host.sweepGates(this.host.now());
  }

  /**
   * The containment refinement (captain-approved 2026-09-19): a live child
   * the host commissioned as part of delivering this task - today exactly
   * the independent review - is retired with it, silently, the way a
   * superseded escalation attempt is: runtime aborted, worktree gone, lane
   * purged. The parent's own close line is the news; an orphaned reviewer
   * idling against a closed builder was the bug this exists to end.
   */
  async retireDeliveryChildren(parentId: string, parentTitle?: string): Promise<void> {
    const live = this.host.tasks
      .children(parentId)
      .filter((child) => !TaskService.isClosed(child) && TaskService.isDeliveryChild(child));
    for (const child of live) {
      await this.closeTask(child.id, {
        status: "dropped",
        reason: "superseded",
        actor: "host",
        text: `superseded - ${parentTitle ? `"${parentTitle}"` : "its builder"} closed`,
        feed: false,
      }).catch(() => {});
    }
  }

  /**
   * The record side of finish(): a crewmate turn that cancelled or failed
   * closes the record, retires its open cards, and saves/removes its worktree.
   * There is no `completed` here any more (WI-11): a crewmate that finished
   * its work and went idle is not a close - it stays `active` and resumable
   * until the captain merges, lands, or discards. A failure a typed backend
   * reported keeps that fact, so the feed line never reads its words for a
   * class (docs/quota.md "Typed cut-offs").
   */
  closeRecord(
    taskId: string,
    status: "cancelled" | "failed",
    error: string | undefined,
    actor: "captain" | "firstmate" | "host",
    typed?: TypedFailure,
  ): void {
    const record = this.host.tasks.get(taskId);
    const sentence = status === "cancelled" ? this.takeClosingSentence(taskId, actor) : undefined;
    this.closeAndPurge([taskId], () => {
      if (status === "cancelled") {
        this.host.tasks.close(taskId, {
          status: "dropped",
          reason: "cancelled",
          actor,
          ...(sentence ? { data: { closingSentence: sentence } } : {}),
        });
      } else {
        this.host.tasks.close(taskId, {
          status: "dropped",
          reason: "failed",
          actor,
          ...(error ? { error } : {}),
          ...(typed
            ? {
                data: {
                  failureSignals: "typed",
                  ...(typed.cutOff ? { cutOff: typed.cutOff } : {}),
                },
              }
            : {}),
        });
      }
    });
    void this.closeOpenPullRequest(taskId);
    this.host.cards.retireTaskCards(taskId, status);
    if (record && sentence) this.leaveClosingNote(record, "cancelled", sentence);
    void this.retireDeliveryChildren(taskId, this.host.tasks.get(taskId)?.title);
    void this.retireWorkspace(taskId);
  }

  /**
   * A closed task's worktree ALWAYS goes (captain, 2026-09-22: "when a
   * task closes, its worktree gets cleaned up period. no exceptions"): a
   * done or dropped row never keeps `present`. What it holds that never
   * landed is saved on the task's hidden kept ref first
   * (`WorkspaceService.retireTaskWorktree`), so nothing is destroyed; the
   * one exception is a save that fails, which keeps the tree and says so.
   */
  retireWorkspace(
    taskId: string,
    options: { keepAlways?: boolean; noteKept?: boolean } = {},
  ): Promise<"removed" | "kept" | "none"> {
    const retirement = this.retireClosedWorkspace(taskId, options).finally(() => {
      if (this.retirements.get(taskId) === retirement) this.retirements.delete(taskId);
    });
    this.retirements.set(taskId, retirement);
    return retirement;
  }

  /** A replacement waits for the close's save before reading its predecessor's work. */
  finishWorkspaceRetirement(taskId: string): Promise<"removed" | "kept" | "none"> {
    return this.retirements.get(taskId) ?? this.retireWorkspace(taskId);
  }

  private async retireClosedWorkspace(
    taskId: string,
    options: { keepAlways?: boolean; noteKept?: boolean },
  ): Promise<"removed" | "kept" | "none"> {
    const record = this.host.tasks.get(taskId);
    if (!record?.worktreeDir || record.workspaceState !== "present") return "none";
    if (record.status !== "done" && record.status !== "dropped") return "none";
    if (this.host.runtimeState(taskId) !== undefined) return "none";
    try {
      return await this.retireWorktreeOf(record, options);
    } catch (caught) {
      // The save succeeded or was not needed, but removing the tree failed:
      // the next boot's hygiene pass tries again.
      console.warn(`[workspace] could not remove the working copy of task ${taskId}:`, caught);
      return "kept";
    }
  }

  /**
   * The one retirement of a record's worktree. An ANSWER task's worktree
   * (Task B) was a laboratory the brief said would be discarded, so it
   * goes with nothing saved; every other goes through the save first. The
   * timeline says what happened: a save as a quiet line (the ref itself
   * stays in the event's data, never in words a surface shows), a failed
   * save as a feed line - a kept tree is never silent again.
   */
  private async retireWorktreeOf(
    record: TaskRecord,
    options: { keepAlways?: boolean; force?: boolean; noteKept?: boolean } = {},
  ): Promise<"removed" | "kept" | "none"> {
    // PlacedSessions observes the closed record and PlacedCopies saves and
    // retires its copy there, at reconnect if necessary. A remote path must
    // never be inspected here or marked removed before that owner confirms it.
    if (record.deviceId) return record.workspaceState === "present" ? "kept" : "none";
    const taskId = record.id;
    const workspace = workspaceOf(record);
    const stillPresent = () => this.host.tasks.get(taskId)?.workspaceState === "present";
    if (this.host.deliverableOf(record) === "answer") {
      await this.host.workspace.removeTaskWorktree(workspace);
      this.host.tasks.markWorkspaceRemoved(taskId);
      return "removed";
    }
    const retired = await this.host.workspace.retireTaskWorktree(
      workspace,
      options.keepAlways ? { keepAlways: true } : {},
    );
    if (retired.outcome === "kept") {
      if (options.force) {
        await this.host.workspace.removeTaskWorktree(workspace);
        this.host.tasks.markWorkspaceRemoved(taskId);
        return "removed";
      }
      // Git was awaited: a concurrent close may have removed it meanwhile.
      if (!stillPresent()) return "none";
      if (options.noteKept !== false) {
        this.host.tasks.note(
          taskId,
          "working copy kept - its work could not be saved first; discard to remove it",
          { news: true, feed: true, data: { kept: true, reason: retired.reason } },
        );
      }
      return "kept";
    }
    if (stillPresent()) this.host.tasks.markWorkspaceRemoved(taskId);
    if (retired.kept) {
      this.host.tasks.note(
        taskId,
        `working copy removed - ${keptWorkWords(retired.kept)} saved first`,
        { news: false, data: { saved: retired.kept } },
      );
    }
    return "removed";
  }

  /**
   * Close and purge as one commit (interaction P0, WI-2): the record closes
   * in the same transaction that deletes the task's lane rows and every
   * queued wake about it, so no reader ever sees a closed task with a live
   * wake. Background jobs are killed right before, synchronously - a
   * process is not a row - and a job that still exits later becomes a feed
   * line, never a wake (deliverJobResult).
   */
  closeAndPurge<T>(taskIds: string[], close: () => T): T {
    for (const id of taskIds) this.host.killJobs?.(id);
    return this.host.inbox.transaction(() => {
      for (const id of taskIds) this.host.inbox.purgeTask(id);
      return close();
    });
  }
}
