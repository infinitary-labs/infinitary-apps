import type { CutOffClass } from "@shared/authFailure";
import { type Card, cardWord } from "@shared/cards";
import { reportSummary } from "@shared/feed";
import { holdNames, type OverridableHold } from "@shared/holds";
import { plainProblem, typedFailureOf } from "@shared/plainProblem";
import { type SteerEventData, TASK_CARD_VIA } from "@shared/provenance";
import { formatDurationShort } from "@shared/quotaSignals";
import { CI_ROUND_CAP, REVIEW_ROUND_CAP } from "@shared/rigor";
import type { ServedWakeOrigin } from "@shared/servedFrame";
import { capWithOverflow } from "../overflow";
import { FIRSTMATE_RECIPIENT, INBOX_ATTEMPT_MAX, type InboxStore } from "../storage/inboxStore";
import {
  type FirstmateAsk,
  standingCap,
  type TaskDelivery,
  type TaskGate,
  type TaskRecord,
} from "../storage/taskStore";
import { type DependencyWait, standingDependencyWaits } from "../tasks/dependencyWaits";
import { builtOnRows } from "../tasks/taskQuery";
import { TaskService } from "../tasks/taskService";
import { cardEmitter } from "./cardService";
import { escapeCardText } from "./cardText";
import { crewHoldWays, idleStallWays } from "./holds";
import { type IdleRule, type IdleTurn, idleTurn, type Witnesses } from "./reportSort";
import {
  CUT_OFF_ONCE_PREFIX,
  ciCapWake,
  cutOffOnce,
  dependencyClosedOnce,
  dependencyClosedWake,
  idleNudge,
  jobBoundOnce,
  jobBoundWake,
  providerBackOnce,
  providerBackWake,
  providerCutOffWake,
  type ReviewVerdictFacts,
  recoveredWake,
  reviewCapWake,
  stillDownOnce,
  stillDownWake,
  type TypedWake,
  type WakeFacts,
  type WakeNote,
  type WakeTask,
  wakeBuiltOn,
} from "./wakes";

/**
 * The idle ladder and the holds (captain-approved 2026-09-26 and the
 * primitives review's P2, docs/report-sort.md "The idle ladder",
 * docs/task-graph.md "Gates"): the one module that answers "is this task
 * moving, and whose turn is it" for every reader, and acts when the answer
 * is nobody's.
 *
 * - `witnesses(taskId, now)` gathers the typed facts once; the report's
 *   sort (`sortReport`) and the reconciler (`idleTurn`) both read them.
 * - The gate is one of them. A `captain` gate is the captain's turn while
 *   the card it names is up, and the Firstmate's while no card is (a round
 *   cap before its card); an `at-time` gate is a wait the sweep clears.
 * - The caps and every card with actions place the `captain` gate
 *   (`syncCaptainGate`); a card leaving, the captain's answer or an
 *   in-person steer release it, and a release restarts the idle clock.
 * - The ready sweep walks open rows (dispatch) and active rows (a due
 *   timed wait, or a wait on another task that closed, becomes one steer
 *   on the task's lane, never a dispatch).
 *
 * The supervisor composes it and supplies the runtime, the card stack and
 * the steer path through `IdleLadderHost`. Nothing here closes, lands or
 * discards a task.
 */

/**
 * The ladder's clock (docs/report-sort.md). Constants, never settings, and
 * exported so tests reason in their units: the nudge to the crewmate at ten
 * idle minutes, the wake to the Firstmate ten minutes after that, and a
 * wake counts as ignored after thirty minutes with no Firstmate action on
 * the task - the second ignored one raises the host's own card.
 */
export const STALL_WAKE_MS = 10 * 60 * 1000;
export const IDLE_WAKE_MS = 20 * 60 * 1000;
export const IDLE_IGNORED_MS = 30 * 60 * 1000;
/**
 * The wakes a crewmate's unanswered request gets (FI3-714): the report's
 * own, then two reminders, thirty minutes apart, and nothing after them.
 */
export const ASKED_WAKES = 3;
/** A background job counts as moving for a turn's own wall-clock bound and no longer. */
export const JOB_BOUND_MS = 2 * 60 * 60 * 1000;
/** The honest retry's still-down wake (the captain's Q1 note: "can we make it 15?"). */
export const STILL_DOWN_MS = 15 * 60 * 1000;

/**
 * The steer a timed wait on an active task ends with (the sweep's active
 * branch), naming the task's oldest job when one still runs (INF-1244).
 */
export function timedWaitOver(gate: TaskGate, job?: RunningJob, now?: number): TypedWake {
  return {
    facts: {
      kind: "timed-wait-over",
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(job && now !== undefined
        ? {
            job: {
              command: capWithOverflow(job.command, "timed-wait-command"),
              runMs: now - job.startedAt,
            },
          }
        : {}),
    },
  };
}

/**
 * Whether the Firstmate declared the task an internal step (FI3-801): its
 * nudge asks for its answer, never the completion card its brief forbids.
 */
/** The waiting cards a stall wake names, when any are open. */
function waitingFact(waiting: WakeNote[]): { waiting?: WakeNote[] } {
  return waiting.length > 0 ? { waiting } : {};
}

function declaredStep(record: TaskRecord | undefined): boolean {
  return record?.shape?.internal_step === true;
}

/** The host's own card for a task the idle ladder could not move (rung 3). */
export function stallCardId(taskId: string): string {
  return `card-stall-${taskId}`;
}

/** That card's title: the task's own, and how long it has been stuck. */
export function stallCardTitle(title: string, stuckFor: string): string {
  return `${title} has been stuck for ${stuckFor}`;
}

/** The timeline events that are the Firstmate acting on a task (the ladder's "ignored" test). */
const FIRSTMATE_ACTS: ReadonlySet<string> = new Set([
  "steered",
  "interrupted",
  "card_raised",
  "answered",
]);

const HOST_CARD_PRIORITY = 40;

export type RunningJob = { jobId: string; command: string; startedAt: number };

/** What says which account serves a task: this Mac's own on its record, or where it runs. */
export type TaskAccount = Pick<TaskRecord, "id" | "accountId" | "deviceId">;

/**
 * What crew delivery reads of an account's serveability (the cut-off
 * contract, docs/quota.md "Typed cut-offs"): the typed cut-off standing on
 * it - the one predicate the hold and the wakes read - from the vault.
 */
export type AccountServeability = {
  /** The cut-off standing on the account, if any (`AccountVault.cutOff`). */
  cutOff(accountId: string): { class: CutOffClass; since: number; resetsAt?: number } | undefined;
  /** The account's provider as the captain names it. */
  providerName(accountId: string): string;
  /**
   * Whether what stands on the account can be read now; absent, always. A
   * computer that runs work that has said nothing of its sign-ins since
   * this Mac started is not known yet, so a cut-off it told of is neither
   * held nor called over.
   */
  known?(accountId: string): boolean;
};

/**
 * The ref an account's cut-off wakes go out under: none, since they are
 * about an account, not one task - so a task closing never purges them, and
 * their once-names are the account's alone.
 */
const ACCOUNT_WAKE_REF = "";

/** What the ladder needs from the supervisor that composes it. */
export type IdleLadderHost = {
  /** The host's one clock (the ticker's). */
  now: () => number;
  tasks: TaskService;
  inbox: InboxStore;
  /** The task's live crewmate, when a runtime holds it. */
  runtime(
    taskId: string,
  ): { state: "starting" | "streaming" | "idle"; crewmate: string } | undefined;
  hasRunningJobs?: (taskId: string) => boolean;
  oldestRunningJob?: (taskId: string) => RunningJob | undefined;
  /** The cards on the stack now. */
  openCards(): Iterable<Card>;
  /** The task's open cards whose captain reply waits on their author, oldest first. */
  threadsAwaitingAuthor(taskId: string): WakeNote[];
  /** The reviewed lane and review tasks bypass supervision. */
  bypassesSupervision(taskId: string): boolean;
  notifyOp(wake: TypedWake, origin: ServedWakeOrigin, taskId?: string): void;
  premiumCanServe?: () => boolean;
  /**
   * One ledger row per act, with its effect in the same transaction: the
   * wake it sent, typed, or the line that records what went up instead.
   */
  recordSort(
    taskId: string,
    title: string,
    wake: string | TypedWake,
    verdict: "routine" | "captain",
    reason: string,
    rule: IdleRule,
    effect: () => void,
  ): void;
  /** The supervisor's own steer on the task's durable lane (actor supervisor). */
  steer(taskId: string, message: TypedWake): Promise<unknown>;
  /** Put a host card on the stack, or take one down unanswered. */
  raiseCard(card: Card): void;
  withdrawCard(id: string, resolution: string): void;
  /** Whether a captain reply on an open card still waits for its answer. */
  answerOwed(cardId: string): boolean;
  /** The ready sweep's effects: a queued start, a dead wait's wake, containers, counts. */
  dispatchQueuedTask(taskId: string): Promise<unknown>;
  /** Accounts' serveability; absent = every account serves (no cut-off watch). */
  serveability?: AccountServeability;
  /**
   * The account a task on a computer that runs work is served by there, as
   * `serveability` keys it (`CrewMachines.accountOf`); absent = none is.
   */
  placedAccount?: (deviceId: string, taskId: string) => string | undefined;
  /**
   * The task runs on a computer that runs work, out of reach or back and not
   * yet caught up: its turn goes on there, unseen here. Absent = every task
   * runs here.
   */
  outOfReach?: (taskId: string) => boolean;
  /** Deliver a task lane's due rows now, resuming the task when no runtime holds it. */
  deliverLane(taskId: string): void;
  /**
   * The account a cut-off held a task on serves again: the sign-in card its
   * turn raised comes down, since nothing is left to sign in to. Absent =
   * no card is raised for one.
   */
  accountBack?: (taskId: string) => void;
  quotaGateCleared?: (ref: string) => boolean;
  /**
   * An Automatic task held on its own level's reset, which a computer other
   * than this one may end first: only its choice reads that, so the sweep
   * asks it again whatever this computer's quota says. Absent = none is.
   */
  heldOnItsLevel?: (record: TaskRecord) => boolean;
  wakeDeadGate(record: TaskRecord, dead: TaskRecord): void;
  completeContainers(): void;
  broadcastCrewCounts(): void;
  /** The host watches the task's checks for it (`./checkWatch.ts`); absent = nothing is watched. */
  checksWatched?: (record: TaskRecord) => boolean;
  /**
   * The task's browser is in the captain's hands (docs/task-browser.md,
   * "Taking control"); absent = no task has a browser.
   */
  browserWithCaptain?: (taskId: string) => boolean;
};

export class IdleLadder {
  /**
   * The dependency waits whose end this process already tried to steer
   * about: a steer that could not go (no conversation to resume) records
   * no once-name, so this keeps the sweep from retrying it every tick.
   */
  private readonly resumesTried = new Set<string>();

  constructor(private readonly host: IdleLadderHost) {}

  // ---- the witnesses ------------------------------------------------------

  /**
   * The witness set for a task (docs/report-sort.md): gathered here once, so
   * the report's sort and the reconciler read the same facts the same way.
   * Cards are read by task, never by id; guidance is anything its lane will
   * still deliver, backoff included; a job counts inside its bound.
   */
  witnesses(taskId: string, now: number): Witnesses {
    const record = this.host.tasks.get(taskId);
    const gate = record?.gate ?? null;
    const cardUp = this.decisionCardsFor(taskId).length > 0;
    const gateCardUp =
      gate?.kind === "captain" && gate.ref !== undefined && this.cardOpen(gate.ref);
    // A wait its crewmate declared is the captain's turn while a card of
    // the task is on his screen (FI3-435), unless a round cap stands, whose
    // card the Firstmate owes. With no card up he has nothing to answer, so
    // its gate is a card the Firstmate owes as well (INF-11).
    const captainWait =
      Boolean(record?.delivery?.captainWait) &&
      !standingCap(record?.delivery) &&
      (cardUp || gateCardUp || this.anyCardFor(taskId));
    // A browser in the captain's hands wakes its crewmate when he returns it.
    const browserWithCaptain = this.host.browserWithCaptain?.(taskId) === true;
    // Work its crewmate declared finished waits on his close of its own card
    // (INF-731): that close is its crewmate's next turn.
    const finished = record?.delivery?.finishedAt !== undefined;
    const finishedCardUp = finished && this.ownCardFor(taskId);
    return {
      threadAwaitingAuthor: this.host.threadsAwaitingAuthor(taskId).length > 0,
      decisionCardOpen: cardUp || gateCardUp || captainWait || browserWithCaptain,
      captainWait,
      finishedCardUp,
      // With no card of its own up, only the Firstmate's close is left
      // (INF-1428): never a nudge for a crewmate with nothing left to do.
      finishedNoCard: finished && !finishedCardUp,
      browserWithCaptain,
      askedFirstmate: record ? this.unansweredAsk(record) !== undefined : false,
      captainGateOwed: gate?.kind === "captain" && !cardUp && !gateCardUp && !captainWait,
      deliverable: this.host.inbox.hasDeliverable(taskId, INBOX_ATTEMPT_MAX),
      jobsRunning: this.jobInBound(taskId, now),
      pendingSettle: Boolean(record?.pendingSettle),
      // A due one is the sweep's, on this same tick: counting it until then
      // keeps the nudge and the wait's own steer from both going out.
      timedWait: gate?.kind === "at-time",
      checksWatched: record ? this.host.checksWatched?.(record) === true : false,
      accountHeld: record ? this.cutOffHolds(record) : false,
      outOfReach: this.host.outOfReach?.(taskId) === true,
      ...(record ? this.waitWitnesses(record) : { waitsOnUnstarted: false }),
    };
  }

  /**
   * A wait on work nobody has started is the Firstmate's to start (FI3-671);
   * a wait on work underway, with nothing unstarted beside it, moves on its
   * own: the sweep resumes it when that work closes (FI3-250).
   */
  private waitWitnesses(
    record: TaskRecord,
  ): Pick<Witnesses, "waitsOnUnstarted" | "waitsOnUnderway"> {
    const unstarted = this.unstartedWaits(record).length > 0;
    return {
      waitsOnUnstarted: unstarted,
      waitsOnUnderway: !unstarted && this.underwayWaits(record).length > 0,
    };
  }

  /**
   * Its crewmate's request that the Firstmate act, while it stands
   * unanswered (FI3-714): its last report asked (`needs_firstmate`, kept
   * until its next turn starts), and the Firstmate has not acted on the
   * task since.
   */
  unansweredAsk(record: TaskRecord): LadderAsk | undefined {
    const ask = this.askOf(record);
    if (!ask) return undefined;
    return this.firstmateActedSince(record, ask.at) === undefined ? ask : undefined;
  }

  /**
   * What its crewmate's last report asked of the Firstmate: its own
   * request (`needs_firstmate`), or else work it declared finished with no
   * card of its own up (INF-1428), which only the Firstmate's close ends -
   * its crewmate has nothing left to do, so nothing nudges it.
   */
  private askOf(record: TaskRecord): LadderAsk | undefined {
    const ask = record.delivery?.needsFirstmate;
    if (ask) return ask;
    const finishedAt = record.delivery?.finishedAt;
    if (finishedAt === undefined || this.ownCardFor(record.id)) return undefined;
    return { at: finishedAt, finished: true };
  }

  /**
   * When the Firstmate first acted on a task after `since`, if it has
   * (FI3-714): an event of its own on the task's timeline - a steer, an
   * interrupt, a card, a change, a link, a close - never the `decided`
   * record each of its turns about the task leaves; or a task built on it
   * (its basis) or under it (its parent) created or started since, open or
   * closed alike, so a successor that already merged or was dropped still
   * stands as the act it was (INF-976). An act before the request answers
   * no later one. What the act was is never judged, only that one took
   * effect.
   */
  private firstmateActedSince(record: TaskRecord, since: number): number | undefined {
    let first: number | undefined;
    const take = (at: number | null | undefined) => {
      if (at != null && at > since && (first === undefined || at < first)) first = at;
    };
    const tasks = this.host.tasks;
    for (const event of tasks.timeline(record.id)) {
      if (event.actor === "firstmate" && event.kind !== "decided") take(event.at);
    }
    for (const other of [...tasks.builtOn(record.id), ...tasks.children(record.id)]) {
      take(other.createdAt);
      take(other.startedAt);
    }
    return first;
  }

  /**
   * Every typed wait a task stands on, with how it was declared and when it
   * began: a task its standing baseline wait names (FI3-671), and every
   * task a `blocks` edge runs from (a `blocks_me` follow-up, a link the
   * Firstmate made). Host delivery machinery (a review) never counts: its
   * own verdict moves its builder.
   */
  private dependencyWaits(record: TaskRecord): TaskWait[] {
    const tasks = this.host.tasks;
    const baseline = standingDependencyWaits(tasks, record.delivery).map(
      (wait): TaskWait => ({ ...wait, kind: "baseline" }),
    );
    const blocks = tasks.linksTo(record.id).flatMap((link): TaskWait[] => {
      const task = link.type === "blocks" ? tasks.get(link.fromId) : undefined;
      return task ? [{ task, since: link.createdAt, kind: "blocks" }] : [];
    });
    return [...baseline, ...blocks].filter((wait) => !TaskService.isDeliveryChild(wait.task));
  }

  /**
   * The work a task waits on that only a start begins (FI3-671), from both
   * typed waits: a task its standing baseline wait names, and a blocker
   * holding its close. Closed work is not waiting to start, including a
   * dropped baseline dependency; its close already resumes the waiter. A
   * named task that cannot start until its own blockers close stands for
   * those blockers (the wait chain, INF-1428): the work only a start begins
   * is whatever that chain reaches, so a chain that ends in work underway
   * names nothing here.
   */
  unstartedWaits(record: TaskRecord): TaskRecord[] {
    return [
      ...new Map(
        uniqueTasks(this.liveWaits(record))
          .flatMap((task) => this.chainOf(task, new Set([record.id])).unstarted)
          .map((task) => [task.id, task]),
      ).values(),
    ];
  }

  /**
   * The work a task waits on that is underway, or queued to start by itself
   * (FI3-250): live, and not something only a start begins - or a task
   * that cannot start until its own blockers close, every one of them
   * underway in turn (the wait chain, INF-1428). The task moves again when
   * it closes, or the chain's next report says what needs a start.
   */
  underwayWaits(record: TaskRecord): TaskRecord[] {
    return uniqueTasks(this.liveWaits(record)).filter(
      (task) => this.chainOf(task, new Set([record.id])).unstarted.length === 0,
    );
  }

  /** The typed waits whose work is still live. */
  private liveWaits(record: TaskRecord): TaskWait[] {
    return this.dependencyWaits(record).filter(({ task }) => TaskService.blockerHoldsClose(task));
  }

  /**
   * Where a live wait on `task` leads (INF-1428): work underway moves by
   * itself; an open task that cannot start until its own blockers close
   * waits on them, read the same way; anything else only a start begins,
   * including an open task a dropped blocker holds, which nothing will
   * free. A task already on the path is not followed again, so a cycle
   * ends on the task that closes it, which only a start begins.
   */
  private chainOf(task: TaskRecord, path: ReadonlySet<string>): { unstarted: TaskRecord[] } {
    const tasks = this.host.tasks;
    if (!tasks.awaitsStart(task)) return { unstarted: [] };
    if (task.status !== "open") return { unstarted: [task] };
    const blockers = tasks.waitingOn(task.id);
    if (blockers.length === 0 || blockers.some((blocker) => blocker.status === "dropped"))
      return { unstarted: [task] };
    const onPath = new Set([...path, task.id]);
    const ahead = blockers.filter((blocker) => !onPath.has(blocker.id));
    if (ahead.length === 0) return { unstarted: [task] };
    return { unstarted: ahead.flatMap((blocker) => this.chainOf(blocker, onPath).unstarted) };
  }

  /**
   * The started work held on this task through a recorded wait (INF-735):
   * every active task a `blocks` link from it reaches with no
   * must-merge-first mark - the practical wait the Firstmate records, such
   * as a hold on this task's finding. Its report may carry what that work
   * waits for, which only the Firstmate can judge and pass on; the close
   * that ends the wait may be days away. A marked edge and a baseline wait
   * are waits on its merge, and its close still ends them.
   */
  heldOn(record: TaskRecord): TaskRecord[] {
    const tasks = this.host.tasks;
    return tasks.linksFrom(record.id).flatMap((link) => {
      if (link.type !== "blocks" || link.holdsMerge) return [];
      const waiter = tasks.get(link.toId);
      return waiter?.status === "active" ? [waiter] : [];
    });
  }

  /**
   * The waits whose work closed while the task waited on it (FI3-250): the
   * task it named is done or dropped, and it closed after the wait began
   * and after the task started - so a continuation its origin's close
   * started is no resume - and the task has not gone idle since, so a turn
   * that already ran past the close is not told it again. A baseline wait
   * outranks a link naming the same work: its words say more.
   */
  private endedWaits(record: TaskRecord): TaskWait[] {
    const ended = new Map<string, TaskWait>();
    for (const wait of this.dependencyWaits(record)) {
      const closedAt = wait.task.closedAt;
      if (!TaskService.isClosed(wait.task) || closedAt == null) continue;
      if (closedAt < Math.max(wait.since ?? 0, record.startedAt ?? 0)) continue;
      if (record.idleSince != null && record.idleSince > closedAt) continue;
      if (ended.get(wait.task.id)?.kind !== "baseline") ended.set(wait.task.id, wait);
    }
    return [...ended.values()];
  }

  /** The open cards with actions on a task, whoever wrote them (`cardWord`). */
  private decisionCardsFor(taskId: string): Card[] {
    return [...this.host.openCards()].filter(
      (card) => card.taskId === taskId && cardWord(card) === "decision",
    );
  }

  /**
   * The newest note up on a task, whoever wrote it (FI3-438): it holds no
   * turn, but what the ladder sends names it rather than claim no card is up.
   */
  private noteFor(taskId: string): WakeNote | undefined {
    const notes = [...this.host.openCards()].filter(
      (card) => card.taskId === taskId && cardWord(card) === "note",
    );
    const note = newestCard(notes);
    return note ? { id: note.id, title: note.title } : undefined;
  }

  /** The stall card's Nudge: the nudge, naming the newest note up on the task, as rung 1 does. */
  nudgeFor(taskId: string): TypedWake {
    return idleNudge(false, this.noteFor(taskId), declaredStep(this.host.tasks.get(taskId)));
  }

  private cardOpen(id: string): boolean {
    for (const card of this.host.openCards()) if (card.id === id) return true;
    return false;
  }

  /** Any card open on a task, a note included: something on the captain's screen to answer. */
  private anyCardFor(taskId: string): boolean {
    for (const card of this.host.openCards()) if (card.taskId === taskId) return true;
    return false;
  }

  /** A card its crewmate emitted, a note included: the one whose close reaches that crewmate. */
  private ownCardFor(taskId: string): boolean {
    for (const card of this.host.openCards()) {
      if (card.taskId === taskId && cardEmitter(card.id, taskId) === "crewmate") return true;
    }
    return false;
  }

  private jobInBound(taskId: string, now: number): boolean {
    if (this.host.hasRunningJobs?.(taskId) !== true) return false;
    const job = this.host.oldestRunningJob?.(taskId);
    return !job || now - job.startedAt < JOB_BOUND_MS;
  }

  // ---- the reconciler -----------------------------------------------------

  /**
   * The idle reconciler (captain-approved 2026-09-26; docs/report-sort.md,
   * "The idle ladder"): the one supervisor of every idle crewmate, whatever
   * situation left it idle. The tick, every idle boundary and the boot
   * sweep run it over every live idle record, with or without a runtime,
   * and it reads the witnesses in the whose-turn rule's order (`idleTurn`):
   * the captain wrote last and nothing will answer him, its crewmate's
   * request waits on the Firstmate, a card is up, the task is moving, the
   * gate holds it for a card nobody raised yet, or nobody's turn - and only
   * the request, the gate and nobody's turn read the durable clock.
   *
   * The only trigger is the absence of a witness, never the name of a
   * situation. Nothing here closes, lands or discards anything.
   */
  reconcileIdle(now: number): void {
    this.checkCutOffs();
    for (const record of this.host.tasks.listActive()) {
      this.reconcileIdleTask(record.id, now);
    }
  }

  reconcileIdleTask(taskId: string, now: number): void {
    let record = this.host.tasks.get(taskId);
    if (!record || TaskService.isClosed(record) || record.kind !== "work") return;
    // The reviewed lane and review tasks bypass supervision, as the sort does.
    if (this.host.bypassesSupervision(taskId)) return;
    this.checkStillDown(record, now);
    const runtime = this.host.runtime(taskId);
    if (runtime ? runtime.state !== "idle" : !TaskService.isResumable(record)) return;
    const witnesses = this.witnesses(taskId, now);
    const turn = idleTurn(witnesses);
    if (turn !== "asked" && this.endAnsweredAsk(record, now)) {
      record = this.host.tasks.get(taskId) ?? record;
    }
    // A check-back later than the job's bound never silences the bound,
    // which stays the backstop (INF-1244).
    if (turn === "moving" && witnesses.timedWait) this.checkJobBound(record, now);
    if (turn === "captain" || turn === "moving") return;
    if (turn !== "thread") this.checkJobBound(record, now);
    this.climb(record, runtime, now, turn);
  }

  /**
   * The Firstmate acted on a request the ladder was raising (FI3-714): its
   * reminders are moot, so the clock starts over, as a gate change restarts
   * it. Read off the record alone: the ladder's last act fell after the
   * request and before the Firstmate's first act since, so it runs once.
   */
  private endAnsweredAsk(record: TaskRecord, now: number): boolean {
    const ask = this.askOf(record);
    const lastAct = record.recoveryAt;
    if (!ask || lastAct == null || lastAct < ask.at || record.idleSince == null) return false;
    const acted = this.firstmateActedSince(record, ask.at);
    if (acted === undefined || lastAct >= acted) return false;
    this.host.tasks.recordRecovery(record.id, { rung: 0, count: 0, at: null, idleSince: now });
    return true;
  }

  /**
   * The standing line an open idle episode puts on a task's crew entry
   * (`stalled 1h 20m · 2 wakes`) once the ladder has acted, while the turn
   * is nobody's - so every captain turn sees it, not only the wake.
   */
  stalledFact(record: TaskRecord, now: number): string | undefined {
    if (record.idleSince == null || record.recoveryAt == null) return undefined;
    const runtime = this.host.runtime(record.id);
    if (runtime && runtime.state !== "idle") return undefined;
    // A request the Firstmate left unanswered stalls it once the ladder has
    // raised it again, whatever card is up (FI3-714).
    const witnesses = this.witnesses(record.id, now);
    const held =
      idleTurn(witnesses) === "asked"
        ? (record.recoveryCount ?? 0) < 2
        : witnesses.decisionCardOpen ||
          witnesses.finishedCardUp === true ||
          witnesses.finishedNoCard === true;
    if ((record.recoveryRung ?? 0) < 3 && held) return undefined;
    const count = record.recoveryCount ?? 0;
    return `stalled ${formatDurationShort(now - record.idleSince)} · ${count} wake${count === 1 ? "" : "s"}`;
  }

  /**
   * A running background job is proof of life for as long as a turn may
   * run (the captain's Q9) and no longer: past the bound, one wake names
   * the job, and the job stops counting so the ladder can climb. Nothing
   * kills it - the bound demands inspection, never an automatic kill. Once
   * per job: the wake names the job (`once`), and the inbox remembers it
   * durably.
   */
  private checkJobBound(record: TaskRecord, now: number): void {
    if (this.host.hasRunningJobs?.(record.id) !== true) return;
    const job = this.host.oldestRunningJob?.(record.id);
    if (!job || now - job.startedAt < JOB_BOUND_MS) return;
    if (this.host.inbox.woken(record.id, jobBoundOnce(job))) return;
    // The command's excerpt spills to an overflow file: computed once, here,
    // and carried as the fact.
    const wake = jobBoundWake(
      record,
      { ...job, command: capWithOverflow(job.command, "job-bound-command") },
      now,
    );
    this.host.recordSort(
      record.id,
      record.title,
      wake,
      "captain",
      "a background job ran past its bound, so it no longer counts as the task moving.",
      "job-bound",
      () => this.host.notifyOp(wake, "agent", record.id),
    );
  }

  /**
   * The honest retry's one wake in the middle of an outage (the captain's
   * Q1): the task's guidance has been failing at the provider for fifteen
   * minutes. Once per outage - the wake names the outage by when it began
   * (`once`), and the inbox remembers it durably, so a restart does not say
   * it again. The recovered wake is `endOutage`'s.
   */
  private checkStillDown(record: TaskRecord, now: number): void {
    // A lane a cut-off holds is the account's wait, and the account's wakes
    // speak for it (`checkCutOffs`); a lane whose computer is out of reach
    // waits for that computer.
    if (this.cutOffHolds(record) || this.host.outOfReach?.(record.id) === true) return;
    const outage = this.host.inbox.outage(record.id);
    if (outage.failures === 0 || outage.since === null) return;
    if (now - outage.since < STILL_DOWN_MS) return;
    if (this.host.inbox.woken(record.id, stillDownOnce(outage.since))) return;
    const crewmate = this.host.runtime(record.id)?.crewmate;
    this.host.notifyOp(
      stillDownWake(
        { ...record, ...(crewmate ? { crewmate } : {}) },
        { since: outage.since, failures: outage.failures },
        now,
      ),
      "agent",
      record.id,
    );
  }

  /**
   * The provider answered on a lane that was failing: every row still
   * backing off is due now, and after two or more failures the Firstmate
   * hears that it recovered.
   */
  endOutage(task: { id: string; title: string; crewmate: string }, failures: number): void {
    this.host.inbox.endOutage(task.id);
    if (failures < 2) return;
    this.host.notifyOp(recoveredWake(task, failures), "agent", task.id);
  }

  // ---- the cut-off on crew lanes -------------------------------------------

  /**
   * The one hold predicate (the cut-off contract): a typed cut-off stands
   * on the task's account - a refusal, a lost sign-in, or a spent allowance
   * until the vault clears it at its reset. Its lane is not attempted, and
   * the account's wakes speak for it rather than the honest retry's own.
   * Every other reason an account serves nothing (no client, a read that
   * says not connected) holds nothing: the turn is attempted and fails the
   * way it always has, so someone hears it. A task on another computer is
   * served there by that computer's own sign-in (docs/helper.md, "Its own
   * sign-ins"), so a cut-off that computer says stands on it holds the
   * task, and none on this Mac's accounts does.
   */
  cutOffHolds(record: TaskAccount): boolean {
    return this.heldBy(record) !== undefined;
  }

  /** The account a cut-off holds a task on, and the cut-off, when one does. */
  heldBy(
    record: TaskAccount,
  ):
    | { account: string; cutOff: { class: CutOffClass; since: number; resetsAt?: number } }
    | undefined {
    const account = this.servingAccount(record);
    const cutOff = account ? this.host.serveability?.cutOff(account) : undefined;
    return account && cutOff ? { account, cutOff } : undefined;
  }

  /**
   * The account a task's turns are served by, as the cut-off contract keys
   * it: its record's, one of this Mac's - or, for a task on a computer that
   * runs work, that computer's own account its conversation there is bound
   * to, never one of this Mac's.
   */
  private servingAccount(record: TaskAccount): string | undefined {
    if (record.deviceId) return this.host.placedAccount?.(record.deviceId, record.id);
    return record.accountId ?? undefined;
  }

  /**
   * The cut-off on crew lanes (docs/inbox.md, "A lane on a withheld
   * account"): the Firstmate hears one typed fact when a cut-off on an
   * account pauses the crewmates on it, and one when it ends. Each goes out
   * once, under a name the inbox keeps durably (`cutOffOnce`,
   * `providerBackOnce`), so a restart neither repeats the first nor loses
   * the second: a cut-off heard about and not yet over is read back from
   * those names. The end makes the lanes' kept rows due at once and
   * delivers them. Nothing here changes a crewmate's model - the Firstmate
   * decides that with its own tools.
   *
   * Runs on the tick, at boot, when a turn meets a cut-off, and when the
   * vault records or clears one; every run is idempotent.
   */
  checkCutOffs(): void {
    const serveability = this.host.serveability;
    if (!serveability) return;
    const open = this.openTasksByAccount();
    for (const [accountId, tasks] of open) {
      const cutOff = serveability.cutOff(accountId);
      if (!cutOff) continue;
      if (this.host.inbox.woken(ACCOUNT_WAKE_REF, cutOffOnce(accountId, cutOff.since))) continue;
      const wake = providerCutOffWake(
        { id: accountId, provider: serveability.providerName(accountId) },
        cutOff,
        tasks,
      );
      this.recordAccountWake(
        tasks,
        wake,
        `its account stopped serving (${cutOff.class}), so its lane holds with its guidance kept; the first mate heard it once for the account.`,
        "provider-cut-off",
      );
    }
    for (const [accountId, since] of this.cutOffsHeard()) {
      if (this.host.inbox.woken(ACCOUNT_WAKE_REF, providerBackOnce(accountId, since))) continue;
      // Not known yet - a computer that has not said - is not over.
      if (serveability.known?.(accountId) === false) continue;
      // Back means the cut-off ended: the one predicate. A failure after it
      // speaks for itself.
      if (serveability.cutOff(accountId)) continue;
      const tasks = open.get(accountId) ?? [];
      for (const task of tasks) this.host.inbox.endOutage(task.id);
      const wake = providerBackWake(
        { id: accountId, provider: serveability.providerName(accountId) },
        since,
        tasks,
      );
      this.recordAccountWake(
        tasks,
        wake,
        "its account serves again, so its kept guidance is due now; the first mate heard it.",
        "provider-back",
      );
      for (const task of tasks) {
        this.host.accountBack?.(task.id);
        this.host.deliverLane(task.id);
      }
    }
  }

  /**
   * The open work tasks served by each account, oldest first: this Mac's
   * own, and a computer's own for a task on that computer.
   */
  private openTasksByAccount(): Map<string, WakeTask[]> {
    const open = new Map<string, WakeTask[]>();
    for (const record of this.host.tasks.listActive()) {
      if (record.kind !== "work") continue;
      const account = this.servingAccount(record);
      if (!account) continue;
      const tasks = open.get(account) ?? [];
      tasks.push({ id: record.id, title: record.title });
      open.set(account, tasks);
    }
    return open;
  }

  /**
   * The newest cut-off the Firstmate heard about on each account, read back
   * from the names its wakes went out once under.
   */
  private cutOffsHeard(): Map<string, number> {
    const heard = new Map<string, number>();
    for (const name of this.host.inbox.wokenNames(ACCOUNT_WAKE_REF, CUT_OFF_ONCE_PREFIX)) {
      const split = name.lastIndexOf(":");
      const accountId = name.slice(CUT_OFF_ONCE_PREFIX.length, split);
      const since = Number(name.slice(split + 1));
      if (!accountId || !Number.isFinite(since)) continue;
      heard.set(accountId, Math.max(heard.get(accountId) ?? since, since));
    }
    return heard;
  }

  /**
   * An account's wake, and one ledger row per task it names, each with the
   * wake's facts; the wake itself rides the first row's transaction. A wake
   * that names no task has no row to ride.
   */
  private recordAccountWake(
    tasks: readonly WakeTask[],
    wake: TypedWake,
    reason: string,
    rule: IdleRule,
  ): void {
    const [first, ...rest] = tasks;
    if (!first) {
      this.host.notifyOp(wake, "agent");
      return;
    }
    this.host.recordSort(first.id, first.title, wake, "captain", reason, rule, () =>
      this.host.notifyOp(wake, "agent"),
    );
    for (const task of rest) {
      this.host.recordSort(task.id, task.title, wake, "captain", reason, rule, () => {});
    }
  }

  /**
   * Nobody's turn, or the Firstmate's: the durable clock decides the rung.
   * The rungs are timed from the rung before - so a clock that already ran
   * long (a job past its bound, a record older than the clock) still gets
   * its nudge, and ten minutes to answer it, before anything wakes the
   * Firstmate. A task the gate holds for a card nobody raised skips the
   * nudge - its crewmate cannot act - and is woken at the nudge's time
   * plus ten. A restart or a sleep changes nothing: the next tick reads
   * the same row.
   */
  private climb(
    record: TaskRecord,
    runtime: { crewmate: string } | undefined,
    now: number,
    turn: Exclude<IdleTurn, "captain" | "moving">,
  ): void {
    const idleSince = record.idleSince;
    if (idleSince == null) {
      // Idle with no clock: a record from before the clock, or one a quit
      // interrupted mid-turn. Its clock starts here.
      this.host.tasks.markIdle(record.id, { at: now });
      return;
    }
    const rung = record.recoveryRung ?? 0;
    const count = record.recoveryCount ?? 0;
    const lastAct = record.recoveryAt;
    if (rung >= 3) return;
    if (turn === "asked") {
      this.climbAsked(record, runtime, now);
      return;
    }
    if (rung === 0 && turn !== "owed") {
      if (now - idleSince < STALL_WAKE_MS) return;
      this.nudge(record, now, turn === "thread");
      return;
    }
    if (rung <= 1) {
      // Skipped (the last turn failed at the provider, or the crewmate
      // cannot act) counts as taken when due.
      const nudgedAt = (rung === 1 ? lastAct : null) ?? idleSince + STALL_WAKE_MS;
      if (now - nudgedAt < IDLE_WAKE_MS - STALL_WAKE_MS) return;
      this.wake(record, runtime, now, 1, turn);
      return;
    }
    // A wake the Firstmate has not been handed yet - its seat is paused, or
    // its lane is backing off - is not ignored: the clock runs from the
    // delivery, kept at the last tick the wake still waited. So a paused
    // seat's one card speaks for the pause, never a stall card per crewmate.
    if (this.host.inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, record.id)) {
      this.host.tasks.recordRecovery(record.id, { rung, count, at: now });
      return;
    }
    const since = Math.max(lastAct ?? idleSince, this.lastFirstmateActionAt(record.id));
    if (now - since < IDLE_IGNORED_MS) return;
    if (count < 2) {
      this.wake(record, runtime, now, count + 1, turn);
      return;
    }
    this.raiseStallCard(record, now);
  }

  /**
   * A crewmate's request the Firstmate has not acted on (FI3-714): the
   * Firstmate's turn, and its crewmate already did its part, so nothing
   * nudges it. Work declared finished with no card of its own up asks for
   * the Firstmate's close the same way (INF-1428). The report's own wake
   * (`rule:needs-firstmate`, or `rule:finished`) was the first, so the ladder counts it as rung 2's first wake, sent when the
   * crewmate asked; from there the rung's own rules run - held while a wake
   * about the task still waits on the Firstmate's lane, and a reminder each
   * time one went thirty minutes without an act. The captain's choice of
   * 2026-10-10: two reminders and no card, since a card would only ask him
   * to send what the app sends itself; after them, the task's crew line
   * says it is stalled. An act of the Firstmate's ends it (`endAnsweredAsk`).
   */
  private climbAsked(
    record: TaskRecord,
    runtime: { crewmate: string } | undefined,
    now: number,
  ): void {
    const ask = this.askOf(record);
    if (!ask) return;
    // The ladder's own acts on this request, never an earlier rung's.
    const ours =
      (record.recoveryRung ?? 0) >= 2 && record.recoveryAt != null && record.recoveryAt >= ask.at;
    const count = ours ? (record.recoveryCount ?? 1) : 1;
    if (count >= ASKED_WAKES) return;
    const since = ours ? (record.recoveryAt ?? ask.at) : ask.at;
    if (this.host.inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, record.id)) {
      this.host.tasks.recordRecovery(record.id, { rung: 2, count, at: now });
      return;
    }
    if (now - since < IDLE_IGNORED_MS) return;
    this.wake(record, runtime, now, count + 1, "asked");
  }

  /**
   * When the Firstmate last acted on a task, read from its timeline: a
   * steer, an interrupt, or a card of its own. A settle that went through
   * closes the task, so the ladder never reads it.
   */
  private lastFirstmateActionAt(taskId: string): number {
    let latest = 0;
    for (const event of this.host.tasks.timeline(taskId)) {
      if (event.actor !== "firstmate") continue;
      if (!FIRSTMATE_ACTS.has(event.kind)) continue;
      latest = Math.max(latest, event.at);
    }
    return latest;
  }

  /**
   * Rung 1: one typed steer to the crewmate, once per episode. It rides the
   * durable lane like any steer, recorded as the supervisor's own, and the
   * turn it starts continues the episode rather than ending it.
   */
  private nudge(record: TaskRecord, now: number, threadUnanswered: boolean): void {
    const note = threadUnanswered ? undefined : this.noteFor(record.id);
    const waiting = threadUnanswered ? this.host.threadsAwaitingAuthor(record.id) : [];
    const nudge = idleNudge(threadUnanswered, note, declaredStep(record), waiting);
    this.host.tasks.recordRecovery(record.id, { rung: 1, count: 0, at: now });
    this.host.recordSort(
      record.id,
      record.title,
      nudge,
      "routine",
      threadUnanswered
        ? "the captain wrote under its card and nothing will deliver an answer; nudged the crewmate."
        : `idle with nothing running, nothing queued and ${note ? "only a note" : "no card"} up; nudged the crewmate.`,
      "idle-nudge",
      () => {
        void this.host.steer(record.id, nudge).catch((caught: unknown) => {
          // The nudge could not go (no conversation to resume): the ladder
          // climbs to the Firstmate on its own clock regardless.
          console.warn("[crew] idle nudge not delivered:", caught);
        });
      },
    );
  }

  /**
   * Rung 2: a wake to the Firstmate carrying the ways out as a hold does,
   * and its one repeat when the first went ignored. A task the gate holds
   * for the captain carries the gate's own hold - the cap's ways, never a
   * stall's - because the Firstmate owes its card. The wake is typed facts
   * (`wakes.ts`); the ledger row and the served turn render the same prose.
   */
  private wake(
    record: TaskRecord,
    runtime: { crewmate: string } | undefined,
    now: number,
    count: number,
    turn: Exclude<IdleTurn, "captain" | "moving">,
  ): void {
    const idleMs = now - (record.idleSince ?? now);
    const note = turn === "nobody" ? this.noteFor(record.id) : undefined;
    const wake =
      turn === "owed"
        ? this.owedWake(record, idleMs, count)
        : turn === "asked"
          ? this.askedWake(record, runtime, now, count)
          : this.stallWake(record, runtime, idleMs, count, turn === "thread", note);
    this.host.tasks.recordRecovery(record.id, { rung: 2, count, at: now });
    this.host.recordSort(
      record.id,
      record.title,
      wake,
      "captain",
      turn === "asked"
        ? count >= ASKED_WAKES
          ? "the first mate has not acted on its crewmate's request since the first reminder; reminded it a last time."
          : "the first mate has not acted on its crewmate's request since the report that asked woke it; reminded it."
        : turn === "owed"
          ? count >= 2
            ? "the first wake about this held task went ignored; woke the first mate again."
            : "held for the captain with no card up; woke the first mate for the card."
          : count >= 2
            ? "the first wake about this idle crewmate went ignored; woke the first mate again."
            : `idle with nothing running, nothing queued and ${note ? "only a note" : "no card"} up, after a nudge; woke the first mate.`,
      count >= 2 ? "idle-repeat" : "idle-wake",
      () => this.host.notifyOp(wake, "agent", record.id),
    );
  }

  private stallWake(
    record: TaskRecord,
    runtime: { crewmate: string } | undefined,
    idleMs: number,
    wakes: number,
    thread: boolean,
    note: WakeNote | undefined,
  ): TypedWake {
    const last = this.lastWords(record);
    const facts: WakeFacts = {
      kind: "idle-stall",
      task: { id: record.id, title: record.title },
      ...(runtime ? { crewmate: runtime.crewmate } : {}),
      key: record.key || record.id,
      idleMs,
      thread,
      ...(thread ? waitingFact(this.host.threadsAwaitingAuthor(record.id)) : {}),
      nudged: this.episodeNudged(record),
      wakes,
      ...(last ? { last } : {}),
      ...(note ? { note } : {}),
    };
    return { facts, ways: idleStallWays(record.id) };
  }

  /**
   * The request again, as the crewmate put it (FI3-714): no ways out, since
   * only the Firstmate knows how to carry it out, and the report that asked.
   */
  private askedWake(
    record: TaskRecord,
    runtime: { crewmate: string } | undefined,
    now: number,
    wakes: number,
  ): TypedWake {
    const ask = this.askOf(record);
    const last = this.lastWords(record);
    const builtOn = wakeBuiltOn(builtOnRows(this.host.tasks, record.id));
    const facts: WakeFacts = {
      kind: "idle-asked",
      task: { id: record.id, title: record.title },
      ...(runtime ? { crewmate: runtime.crewmate } : {}),
      key: record.key || record.id,
      ...(ask && "finished" in ask ? { finished: true } : { request: ask?.request ?? "" }),
      askedMs: now - (ask?.at ?? now),
      wakes,
      ...(builtOn ? { builtOn } : {}),
      ...(last ? { last } : {}),
    };
    return { facts };
  }

  /** The hold a captain gate with no card behind it stands for: the cap's, or the gate's own. */
  private owedWake(record: TaskRecord, idleMs: number, wakes: number): TypedWake {
    const cap = standingCap(record.delivery);
    const reason = record.gate?.reason ?? cap?.reason;
    const facts: WakeFacts = {
      kind: "idle-owed",
      held: cap?.held ?? "captain-gate",
      task: { id: record.id, title: record.title },
      ...(reason ? { reason } : {}),
      idleMs,
      wakes,
    };
    return {
      facts,
      ways: crewHoldWays(record.id, record, undefined, this.host.premiumCanServe?.()),
    };
  }

  /**
   * Whether this idle episode's nudge actually went out: it is skipped
   * after a provider failure, so the rung alone cannot say.
   */
  private episodeNudged(record: TaskRecord): boolean {
    const since = record.idleSince;
    if (since == null) return false;
    return this.host.tasks
      .timeline(record.id)
      .some(
        (event) => event.kind === "steered" && event.actor === "supervisor" && event.at >= since,
      );
  }

  /**
   * The newest of the task's report and its failure, capped once here: an
   * overflow spills to a file, so the capped excerpt is the fact the wake
   * carries, and every render of it names the same file.
   */
  private lastWords(
    record: TaskRecord,
  ): { kind: "report" | "failed"; excerpt: string } | undefined {
    const newest = this.host.tasks
      .timeline(record.id)
      .filter((event) => event.kind === "report" || event.kind === "failed")
      .at(-1);
    if (!newest) return undefined;
    return newest.kind === "report"
      ? { kind: "report", excerpt: capWithOverflow(newest.text, "task-report") }
      : { kind: "failed", excerpt: capWithOverflow(newest.text, "turn-error") };
  }

  /**
   * Rung 3 of the idle ladder (the captain's Q3, a decision of 2026-09-26
   * that revises the card rule): the Firstmate let two wakes about a stuck
   * crewmate go, so the work cannot move without the captain, and the host
   * raises its own card - the app's attention, like the sign-in card. Like
   * every card with actions it places the captain gate on its task, so it
   * holds the turn while it is up and nothing repeats; it leaves on a
   * click, on his close (the keep: rung 3 stays, nothing more this
   * episode), when the task moves - unless a reply under it still waits
   * on the first mate, which answers it (INF-1670) - or when the task closes.
   */
  private raiseStallCard(record: TaskRecord, now: number): void {
    const id = stallCardId(record.id);
    this.host.tasks.recordRecovery(record.id, {
      rung: 3,
      count: record.recoveryCount ?? 0,
      at: now,
    });
    const stuckFor = formatDurationShort(now - (record.idleSince ?? now));
    const last = this.host.tasks
      .timeline(record.id)
      .filter((event) => event.kind === "report" || event.kind === "failed")
      .at(-1);
    const lastLine = !last
      ? "<p>It has not reported anything yet.</p>"
      : last.kind === "report"
        ? `<p>What it last said: ${escapeCardText(reportSummary(last.text) || last.text)}</p>`
        : `<p>Its last try ended in a problem: ${escapeCardText(plainProblem(typeof last.data?.error === "string" ? last.data.error : last.text, typedFailureOf(last.data)))}.</p>`;
    const told = this.episodeNudged(record)
      ? "It was nudged once, and your first mate was told twice, and nothing has moved since."
      : "Your first mate was told twice, and nothing has moved since.";
    // A task a standing cap holds has a question for the captain - the
    // cap's, which the Firstmate never put to him - so its card says so.
    // Nudge stays the nudge and is not the cap's answer
    // (`resetCapsOnSteer`), so the words say what it does not do.
    const cap = standingCap(record.delivery);
    const modelWay = cap
      ? crewHoldWays(record.id, record, undefined, this.host.premiumCanServe?.())
          .find((way) => way.tool === "spawn_crewmate")
          ?.label.toLowerCase()
      : undefined;
    const choices = modelWay ? `try again, ${modelWay}, or discard it` : "try again or discard it";
    // A wait its crewmate declared with no card up is a question nobody put
    // to him (INF-11): the card names it in the crewmate's words.
    const wait = cap ? undefined : record.delivery?.captainWait;
    const opening = cap
      ? `<p>It has reached its limit of tries at ${cap.held === "review-cap" ? "getting through a review" : "getting the checks to pass"}, so it needs your call: ${choices}. Your first mate was told twice and has not asked you yet.</p>`
      : wait
        ? `<p>It waits on you to ${escapeCardText(wait.reason)}, and no card has asked you. ${told}</p>`
        : `<p>It stopped with nothing running and no question for you. ${told}</p>`;
    const nudges = cap
      ? `Nudge tells it to say what is in its way; it does not give it more tries. To try again${modelWay ? ` or ${modelWay}` : ""}, reply here.`
      : "Nudge tells it to finish or say what is in its way.";
    const card: Card = {
      id,
      taskId: record.id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: stallCardTitle(record.title, stuckFor),
      // The head leads with the task's key from `taskId`, as on every card
      // about a task (INF-358), and the title names the task: nothing is
      // left for the meta words to add, so the key reads once (INF-418).
      meta: "",
      body: [
        opening,
        lastLine,
        `<p>${nudges} Keep waiting closes this alert and leaves the task as it is. Discard ends it and throws its work away.${cap ? "" : " For anything else, reply here."}</p>`,
      ].join(""),
      // The captain's choice on INF-1670: a reply here goes to the first
      // mate, which can always answer, and nuanced operations ride it.
      answeredBy: "firstmate",
      actions: [
        {
          id: "nudge",
          label: "Nudge",
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "continue-task", arg: record.id },
        },
        {
          // No effect: the click closes the alert, as the captain's close
          // does (the keep: rung 3 stays, nothing more this episode).
          id: "keep-waiting",
          label: "Keep waiting",
          variant: "secondary",
        },
        {
          id: "discard",
          label: "Discard",
          variant: "danger",
          danger: true,
          effect: { kind: "settle", mode: "discard" },
        },
      ],
      status: "ready",
      createdAt: now,
    };
    // In place of any further wake: the ledger row carries what went up,
    // and the Firstmate's context shows the card and the task's stall line.
    this.host.recordSort(
      record.id,
      record.title,
      `host card ${id}: "${card.title}"`,
      "captain",
      "two wakes about this idle crewmate went ignored; the host raised its own card.",
      "idle-card",
      () => {
        this.host.raiseCard(card);
        this.host.tasks.recordCardRaised(record.id, {
          cardId: id,
          kind: cardWord(card),
          title: card.title,
          actor: "host",
        });
      },
    );
  }

  /**
   * The task moved on its own: its stall card, if the host raised one, is
   * moot - unless the captain replied under it and the first mate's answer
   * has not landed yet (INF-1670): it stays up until that answer arrives.
   */
  withdrawStallCard(taskId: string): void {
    const id = stallCardId(taskId);
    if (!this.cardOpen(id) || this.host.answerOwed(id)) return;
    this.host.withdrawCard(id, "moved");
  }

  // ---- the captain gate ---------------------------------------------------

  /**
   * Keep an active task's `captain` gate true to what holds it (the owner's
   * call 3 on the primitives review; docs/task-graph.md "Gates"): the card
   * with actions that is up on it - the one the gate already names while it
   * stays up, else the newest - or, with no card, a round cap that stands
   * (ref the head it was reached at), or else a wait on the captain its
   * crewmate declared in its report (ref the card it named, its reason the
   * crewmate's; FI3-435). With none of them there is no captain gate. Every card placement and departure, cap and answer runs this,
   * and the sweep runs it on every active row to heal a crash between two
   * writes. A change on an idle record is an act on it - a card the captain
   * answered or closed, a cap placed - so the idle clock restarts there:
   * the first rung acts ten minutes after the close, not on the next tick.
   * Rung 3 stays terminal. A timed wait is left to the sweep.
   */
  syncCaptainGate(taskId: string, now: number): void {
    const record = this.host.tasks.get(taskId);
    if (record?.status !== "active" || record.kind !== "work") return;
    const have = record.gate;
    const want = this.captainGateFor(record);
    if (!want && have?.kind !== "captain") return;
    if (sameGate(want, have)) return;
    this.host.tasks.setGate(taskId, want);
    this.restartClock(record, now);
  }

  private captainGateFor(record: TaskRecord): TaskGate | null {
    const cap = standingCap(record.delivery);
    const reason = cap ? { reason: cap.reason } : {};
    const cards = this.decisionCardsFor(record.id);
    const held = record.gate?.kind === "captain" ? record.gate.ref : undefined;
    const card = cards.find((entry) => entry.id === held) ?? newestCard(cards);
    if (card) return { kind: "captain", ref: card.id, ...reason };
    if (cap) return { kind: "captain", ...(cap.head ? { ref: cap.head } : {}), reason: cap.reason };
    const wait = record.delivery?.captainWait;
    if (wait)
      return { kind: "captain", ...(wait.cardId ? { ref: wait.cardId } : {}), reason: wait.reason };
    return null;
  }

  private restartClock(record: TaskRecord, now: number): void {
    if (record.idleSince == null || (record.recoveryRung ?? 0) >= 3) return;
    this.host.tasks.recordRecovery(record.id, { rung: 0, count: 0, at: null, idleSince: now });
  }

  // ---- the caps -----------------------------------------------------------

  /**
   * The CI round cap was reached on a task (delivery rigor phase 3): the
   * CI service counted the round and stamped `ciCapAt`, which places the
   * captain gate on the task (ref the red head); this is the ONE `[fm-op]`
   * the cap earns, asking the Firstmate for the decision card - retry, a
   * stronger model on the captain's word, or discard. The completion card
   * stays refused until the captain's answer and the Firstmate's steer
   * reopen the rounds; when that card is raised the gate names it.
   */
  holdForCiCap(taskId: string, facts: { rounds: number; headSha: string }): void {
    const record = this.host.tasks.get(taskId);
    if (!record) return;
    this.syncCaptainGate(taskId, this.host.now());
    this.host.notifyOp(
      ciCapWake(record, { ...facts, cap: CI_ROUND_CAP }, this.host.premiumCanServe?.()),
      "agent",
      taskId,
    );
  }

  /**
   * The review cap (phase 3), the CI cap's twin: a third findings verdict
   * is one past the two re-reviews the tier allows. Stamps `reviewCapAt`
   * on the builder with its owner (legacy absence means captain), and returns the
   * `findings` wake with the cap riding it, so the cap is one wake and not
   * a second; a re-review steer to the review task is refused while it
   * holds. Only a captain-owned cap places the captain gate.
   */
  holdForReviewCap(
    builder: TaskRecord,
    rounds: number,
    at: number,
    findings: ReviewVerdictFacts,
    owner: "firstmate" | "captain" = "captain",
  ): TypedWake {
    this.host.tasks.recordChangeEvidence(builder.id, { reviewCapAt: at, reviewCapOwner: owner });
    this.syncCaptainGate(builder.id, at);
    return reviewCapWake(
      builder,
      { rounds, cap: REVIEW_ROUND_CAP, findings, owner },
      this.host.premiumCanServe?.(),
    );
  }

  /**
   * The captain's answer to a Firstmate decision card on a capped task
   * (phase 3): `capAnsweredAt` is the gate's release, the fact the
   * reopening steer needs. A dismissal is not an answer, and a crewmate's
   * own card is not the cap's decision.
   */
  noteCapAnswered(
    card: Card,
    action: string,
    by: "captain" | "firstmate" | "crewmate",
    firstmateCard: boolean,
  ): void {
    if (!card.taskId || by !== "captain" || !firstmateCard) return;
    if (action === "dismissed" || action === "closed") return;
    if (!standingCap(this.host.tasks.get(card.taskId)?.delivery)) return;
    this.host.tasks.recordChangeEvidence(card.taskId, { capAnsweredAt: this.host.now() });
  }

  /**
   * A cap is answered when the captain resolves a Firstmate decision card
   * on the task after the cap was reached (`noteCapAnswered`), or steers
   * the task in person; the Firstmate's steer that follows - the answer,
   * relayed - reopens the rounds. Both counters and both caps clear
   * together: the decision was about the task, not about one counter, and
   * a lineage that starts over starts over whole. The `cap_reset` event
   * records who reopened it, and the captain gate goes with the caps. The
   * Nudge on the stall card or Continue on the task card is the captain's steer but
   * not the cap's answer: neither put the cap's decision to him, so the cap
   * stands.
   */
  resetCapsOnSteer(
    taskId: string,
    source: {
      actor: "firstmate" | "captain" | "supervisor";
      via: SteerEventData["via"];
      cardId: string | null;
    },
  ): void {
    const actor = source.actor;
    if (actor === "supervisor" || source.via === TASK_CARD_VIA) return;
    if (source.cardId === stallCardId(taskId)) return;
    const record = this.host.tasks.get(taskId);
    const delivery = record?.delivery;
    if (!record || !delivery) return;
    // Delegated review caps never authorize reopening the independent CI cap.
    if (
      actor === "firstmate" &&
      delivery.reviewCapAt !== undefined &&
      delivery.reviewCapOwner === "firstmate"
    ) {
      this.host.tasks.recordChangeEvidence(
        taskId,
        {
          reviewRounds: undefined,
          reviewRoundSha: undefined,
          reviewCapAt: undefined,
          reviewCapOwner: undefined,
        },
        {
          kind: "cap_reset",
          actor,
          feed: true,
          text: "The first mate reopened the review rounds: the findings need no captain decision.",
        },
      );
      this.syncCaptainGate(taskId, this.host.now());
      return;
    }
    const capAt = Math.max(delivery.ciCapAt ?? 0, delivery.reviewCapAt ?? 0);
    if (capAt === 0) return;
    const answered =
      actor === "captain" ||
      (delivery.capAnsweredAt !== undefined && delivery.capAnsweredAt >= capAt);
    if (!answered) return;
    const held = [
      ...(delivery.ciCapAt !== undefined ? [`checks cap (${delivery.ciRounds ?? 0} rounds)`] : []),
      ...(delivery.reviewCapAt !== undefined
        ? [`review cap (${delivery.reviewRounds ?? 0} findings rounds)`]
        : []),
    ].join(" and ");
    this.host.tasks.recordChangeEvidence(
      taskId,
      {
        ciRepair: delivery.ciRepair ? { ...delivery.ciRepair, rerun: undefined } : undefined,
        ciRounds: undefined,
        ciRedHead: undefined,
        ciCapAt: undefined,
        reviewRounds: undefined,
        reviewRoundSha: undefined,
        reviewRoundPairs: undefined,
        reviewCapAt: undefined,
        reviewCapOwner: undefined,
        capAnsweredAt: undefined,
      },
      {
        kind: "cap_reset",
        text: `rounds reopened by ${actor === "captain" ? "the captain" : "the first mate"}'s steer after the captain's answer - ${held} reset`,
        actor,
        feed: false,
      },
    );
    this.syncCaptainGate(taskId, this.host.now());
  }

  /**
   * The captain's override on the repair, re-review or rerun limit reopens
   * it at once (docs/delivery-rigor.md, "The holds"): the counters it names
   * clear as an answered steer clears them, with one `cap_reset` row, and
   * the captain gate goes with the cap. While the override lasts, the caps
   * it names do not place again (`standingCap`, `observeCheckRepair`).
   */
  reopenForOverride(taskId: string, kinds: readonly OverridableHold[]): void {
    const delivery = this.host.tasks.get(taskId)?.delivery;
    if (!delivery) return;
    const patch: Partial<TaskDelivery> = {};
    const reopened: OverridableHold[] = [];
    if (
      kinds.includes("repairs") &&
      (delivery.ciRounds !== undefined || delivery.ciCapAt !== undefined)
    ) {
      Object.assign(patch, { ciRounds: undefined, ciRedHead: undefined, ciCapAt: undefined });
      reopened.push("repairs");
    }
    if (
      kinds.includes("rounds") &&
      (delivery.reviewRounds !== undefined || delivery.reviewCapAt !== undefined)
    ) {
      Object.assign(patch, {
        reviewRounds: undefined,
        reviewRoundSha: undefined,
        reviewRoundPairs: undefined,
        reviewCapAt: undefined,
        reviewCapOwner: undefined,
      });
      reopened.push("rounds");
    }
    if (kinds.includes("rerun") && delivery.ciRepair?.rerun) {
      patch.ciRepair = { ...delivery.ciRepair, rerun: undefined };
      reopened.push("rerun");
    }
    if (reopened.length === 0) return;
    this.host.tasks.recordChangeEvidence(
      taskId,
      { ...patch, capAnsweredAt: undefined },
      {
        kind: "cap_reset",
        text: `the captain's override reopened ${holdNames(reopened)}`,
        actor: "firstmate",
        feed: false,
      },
    );
    this.syncCaptainGate(taskId, this.host.now());
  }

  // ---- the ready sweep ----------------------------------------------------

  /**
   * The ready sweep (R1, the ready query since P2). Open rows: a decision
   * or host-card row whose card is gone closes, held work whose gate
   * cleared dispatches, unheld work waiting on a dropped task gets one wake
   * instead of silent rot, and then everything the ready query lists (open,
   * unheld, when-ready, every blocker closed) dispatches in priority order.
   * Active rows: the captain gate is healed to what holds it, and a due
   * timed wait is cleared into one steer on the task's own lane - the
   * ladder's steer path, recorded as the supervisor's - never a dispatch.
   * Runs on the shared tick, after any close, after a graph change, on
   * quota refresh, and once at boot.
   */
  async sweepGates(now: number): Promise<void> {
    const tasks = this.host.tasks;
    for (const record of tasks.listOpen()) {
      const gate = record.gate;
      if (record.delivery?.captainAction) continue;
      if (record.kind === "decision" || (record.kind === "operation" && gate?.kind === "captain")) {
        // A card's row lives exactly as long as its card is on the stack:
        // the choice, a dismissal, or a close_card closes it
        // (recordCardResolution). One whose card is off the stack anyway -
        // a park from before P0, a crash between the two writes - no longer
        // applies and closes quietly; nothing brings a card back.
        const cardId = gate?.ref;
        if (!cardId || !this.cardOpen(cardId)) {
          tasks.close(record.id, {
            status: "dropped",
            reason: "superseded",
            actor: "host",
            text: "its card is gone",
            ...(record.kind === "operation" ? { feed: false } : {}),
          });
          this.host.broadcastCrewCounts();
        }
        continue;
      }
      if (record.kind !== "work") continue;
      // Unheld work is the ready query's business, below.
      if (!gate) continue;
      switch (gate.kind) {
        case "at-time": {
          if (gate.until !== undefined && gate.until <= now) {
            await this.host.dispatchQueuedTask(record.id);
          }
          break;
        }
        case "quota-reset": {
          if (
            gate.ref &&
            (this.host.quotaGateCleared?.(gate.ref) || this.host.heldOnItsLevel?.(record))
          ) {
            await this.host.dispatchQueuedTask(record.id);
          }
          break;
        }
        case "captain":
          // Cleared only by the user's answer on its card.
          break;
      }
    }
    for (const record of tasks.listActive()) {
      if (record.kind !== "work") continue;
      this.syncCaptainGate(record.id, now);
      const gate = tasks.get(record.id)?.gate;
      if (gate?.kind === "at-time" && gate.until !== undefined && gate.until <= now) {
        this.endTimedWait(record.id, gate, now);
      }
      for (const ended of this.endedWaits(record)) this.endDependencyWait(record.id, ended);
    }
    // A wait that can never end (a dropped blocker) is one wake to the
    // Firstmate, whose tools already express every way out; the row stays
    // as it is - no hold, no card (cards/tasks/agents P0, WI-3).
    for (const record of tasks.listDeadBlocked()) {
      const dead = tasks.waitingOn(record.id).find((blocker) => blocker.status === "dropped");
      if (dead) this.host.wakeDeadGate(record, dead);
    }
    // The ready query (design section 7): everything it lists starts now,
    // in priority order. On-request rows never appear in it.
    for (const record of tasks.listReady()) {
      await this.host.dispatchQueuedTask(record.id);
    }
    // A program a Start ran is started: after a quit it runs again from its record.
    for (const record of tasks.listOpen()) {
      if (
        record.shape?.program &&
        record.startPolicy === "on-request" &&
        tasks.programStarted(record.id)
      )
        await this.host.dispatchQueuedTask(record.id);
    }
    this.host.completeContainers();
  }

  /**
   * A timed wait on an active task is over: the gate clears and the task
   * hears it as one steer on its own lane. The wait's end opens a new idle
   * episode, so the turn it starts is the task's own, not a ladder turn.
   */
  private endTimedWait(taskId: string, gate: TaskGate, now: number): void {
    this.host.tasks.setGate(taskId, null);
    this.host.tasks.endIdle(taskId);
    const job = this.host.hasRunningJobs?.(taskId)
      ? this.host.oldestRunningJob?.(taskId)
      : undefined;
    void this.host.steer(taskId, timedWaitOver(gate, job, now)).catch((caught: unknown) => {
      // No conversation to resume: the ladder reads the task on its own clock.
      console.warn("[crew] timed wait's steer not delivered:", caught);
    });
  }

  /**
   * Work a task waited on closed (FI3-250): the task hears it as one steer
   * on its own lane, named by that work so the inbox queues it once, even
   * across a restart. Like a timed wait's end it opens a new idle episode,
   * so the turn it starts is the task's own, not a ladder turn.
   */
  private endDependencyWait(taskId: string, ended: TaskWait): void {
    const once = dependencyClosedOnce(ended.task);
    const tried = `${taskId}\n${once}`;
    if (this.resumesTried.has(tried) || this.host.inbox.woken(taskId, once)) return;
    this.resumesTried.add(tried);
    this.host.tasks.endIdle(taskId);
    void this.host
      .steer(taskId, dependencyClosedWake(ended.task, ended.kind))
      .catch((caught: unknown) => {
        // No conversation to resume: the ladder reads the task on its own clock.
        console.warn("[crew] a closed dependency's steer not delivered:", caught);
      });
  }
}

/** A typed wait a task stands on: how it was declared, and the work it names. */
type TaskWait = DependencyWait & { kind: "baseline" | "blocks" };

/** What a crewmate's last report asked of the Firstmate (`IdleLadder.askOf`). */
type LadderAsk = FirstmateAsk | { at: number; finished: true };

/** The tasks the waits name, each once. */
function uniqueTasks(waits: readonly TaskWait[]): TaskRecord[] {
  return [...new Map(waits.map(({ task }) => [task.id, task])).values()];
}

function newestCard(cards: Card[]): Card | undefined {
  return cards.reduce<Card | undefined>(
    (newest, card) => (!newest || card.createdAt >= newest.createdAt ? card : newest),
    undefined,
  );
}

function sameGate(a: TaskGate | null, b: TaskGate | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.ref === b.ref && a.until === b.until && a.reason === b.reason;
}
