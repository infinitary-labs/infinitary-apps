import { existsSync } from "node:fs";
import type { FiledAfterMergeStep, FirstmateAfterMergeStep } from "@shared/afterMerge";
import { isRoutineMergeCard, isStoryNote, keepsTaskOpen } from "@shared/cards";
import { readyPresentation } from "@shared/changePresentation";
import { currentCheckStatus } from "@shared/checkSnapshot";
import type { FolderRefreshRefusal } from "@shared/folderRefresh";
import { fixedHoldWords, overridePasses, softHoldWords, withoutHoldWords } from "@shared/holds";
import { englishOf, type Said, said } from "@shared/i18n/said";
import type { MergeReview } from "@shared/mergeReview";
import { plainProblem } from "@shared/plainProblem";
import { hostedPresentation } from "@shared/presentationDestination";
import { opensPullRequest } from "@shared/repos";
import type { ForgePull } from "../forge";
import { currentChange } from "../storage/changeProjection";
import type { MergeWait, TaskRecord } from "../storage/taskRecords";
import { SETTLE_FOLD } from "../tasks/taskFeed";
import type { SettleRefusal } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import { type MergeGuard, mergedReceipt, type PrOutcome } from "./changeMerge";
import { afterMergeWords } from "./deliveryWakes";
import type { KeptApproval } from "./keptApproval";
import { candidateHead, keptFeedSaid, keptNote, standingAuthorization } from "./mergeAuthorization";
import type { SettleOutcome, SettleServiceHost } from "./settleHost";
import type { SettleLease, SettleLocks } from "./settleLocks";
import {
  closeGateRefusal,
  type MergeActor,
  mergeGate,
  notSignedInRefusal,
  openCurrentMerge,
} from "./settleRefusals";
import {
  cannotMergeSaid,
  changeName,
  folderNotUpdatedText,
  mergedOnLine,
  placeOf,
  settlingSaid,
} from "./settleWords";
import type { TaskClose, TaskClosing } from "./taskClose";
import type { TaskDrop } from "./taskDrop";
import { taskContributesUpstream } from "./workShape";

/**
 * The feed line for a settle the captain clicked. An outcome with no raw
 * failure is already written in the app's words and reads as-is; one that
 * quotes a git, gh or network error says what it means instead (the
 * vocabulary's error row, `plainProblem`), and the raw text stays on the
 * task's timeline.
 */
export function settleFeedLine(
  mode: "merge-pr" | "land" | "discard",
  result: { ok: boolean; text: string; problem?: string; plain?: string; followup?: string },
): string {
  const line = settleFeedSaid(mode, result);
  return typeof line === "string" ? line : englishOf(line);
}

/**
 * The settle's feed line (`settleFeedLine`) as a fact where the app words
 * it; an outcome already written in words reads as written.
 */
export function settleFeedSaid(
  mode: "merge-pr" | "land" | "discard",
  result: { ok: boolean; text: string; problem?: string; plain?: string; followup?: string },
): string | Said {
  // A hold's sentence tells an agent how it passes; his line leaves it out.
  if (!result.problem && !result.plain) return withoutHoldWords(result.text);
  const plain = result.problem ? plainProblem(result.problem) : (result.plain as string);
  if (mode === "discard") {
    if (!result.ok) return said("settleCouldNotDiscard", { problem: plain });
    return result.followup
      ? said("settleDiscardedPullOpenThen", { problem: plain, followup: result.followup })
      : said("settleDiscardedPullOpen", { problem: plain });
  }
  return cannotMergeSaid(plain);
}

/** The record's state in the words the tools and refusals use. */
export function describeStatus(record: TaskRecord): string {
  if (record.status === "open") return "queued";
  if (record.status === "active") return record.activity ?? "active";
  return record.closedReason ?? record.status;
}

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
export class SettleService {
  constructor(
    private readonly host: SettleServiceHost,
    private readonly locks: SettleLocks,
    private readonly approvals: KeptApproval,
    private readonly closing: TaskClosing,
    private readonly drops: TaskDrop,
  ) {}

  /**
   * The one merge gate (INF-2744): whether the captain's click, the first
   * mate's merge call or the app may merge this task now. Every reader of
   * the task's autonomy for a merge asks here - the card emit that lets
   * the app approve from the merge card, the kept merge run, and each
   * settle's own boundary - so they cannot disagree. `scope` names the
   * pull request it merges (`{ review: undefined }` for the task's own
   * change); without it, the task's current change.
   */
  mergeRefusal(
    record: TaskRecord,
    mode: "merge-pr" | "land",
    actor: MergeActor,
    asksFirst?: string,
    scope?: { review?: string },
  ): SettleRefusal | undefined {
    return mergeGate(this.host, record, mode, actor, asksFirst, scope);
  }

  /** Last synchronous check, after every asynchronous read and before each send. */
  private mergeBoundary(
    lease: SettleLease,
    taskId: string,
    mode: "merge-pr" | "land",
    actor: MergeActor,
    proceedWithOpen: boolean,
  ) {
    const initial = this.host.tasks.get(taskId);
    const signature = initial ? JSON.stringify(this.host.tasks.policiesOf(initial)) : "";
    // A waiting attempt keeps the exact story across restart, never recaptures a newer one.
    const initialStory = initial?.pendingSettle
      ? initial.pendingSettle.story
      : readyPresentation(initial?.delivery?.presentation);
    return (head?: string): string | undefined => {
      const record = this.host.tasks.get(taskId);
      if (!record || TaskService.isClosed(record)) return "the task closed";
      if (signature !== JSON.stringify(this.host.tasks.policiesOf(record)))
        return "its policies changed; recheck the current requirements before trying again";
      if (this.locks.working(taskId)) return "its crewmate is still working";
      if (this.host.deliverableOf(record) !== "change" || record.shape?.kind === "review")
        return `this work has no merge. ${fixedHoldWords("nothing-to-merge")}`;
      const destination = this.host.taskDelivery(taskId);
      if ((mode === "merge-pr") !== opensPullRequest(destination))
        return "the requested destination does not match its current delivery policy";
      const gate = closeGateRefusal(this.host, taskId, mode, proceedWithOpen);
      if (gate) return gate.text;
      const autonomy = this.mergeRefusal(record, mode, actor);
      if (autonomy) return autonomy.text;
      // The version a version-long override is read at: the one being sent.
      const at = head ?? record.delivery?.headSha;
      const story = record.delivery?.presentation?.revisions.at(-1);
      if (
        story &&
        !hostedPresentation(story.destination) &&
        !overridePasses(record.delivery, "story", at)
      ) {
        // Approval follows the code, never the story's words (INF-3623): a
        // story revised at the clicked version lands as the newest one, and
        // only another commit stops the click.
        const ready = readyPresentation(record.delivery?.presentation);
        if (!ready || !initialStory || ready.head !== at)
          return `the newest story is not ready at this version. ${softHoldWords("story", "firstmate")}`;
        if (ready.head !== initialStory.head)
          return `another commit came after the merge card. ${softHoldWords("story", "firstmate")}`;
      }
      if (actor !== "captain" && !overridePasses(record.delivery, "decisions", at)) {
        // The first mate's own cards never hold its own merge (INF-242's
        // question 9): a crewmate's question, a write request or a
        // validation question still does.
        const cards = [...this.host.cards.values()].filter((card) => card.taskId === taskId);
        const decisions = cards.filter((card) => card.actions.length);
        // Nor does the task's story note: the merge card of work that merges
        // on its own, held off the stack until this merge has a result
        // (INF-2533, INF-2744). A wait or gate on the captain reading it waits on the
        // merge itself, like one on a merge offer (INF-2761).
        const passed = new Set(
          cards
            .filter(
              (card) =>
                isStoryNote(card) ||
                (card.actions.length > 0 &&
                  (isRoutineMergeCard(card) || card.author === "firstmate")),
            )
            .map((card) => card.id),
        );
        const gateIsPassed =
          record.gate?.kind === "captain" && record.gate.ref && passed.has(record.gate.ref);
        const wait = record.delivery?.captainWait;
        const waitIsPassed = wait?.cardId && passed.has(wait.cardId);
        // A report's check-back schedules another look, not a decision.
        // Keep scheduled continuations and allowance gates as real holds.
        const reminder =
          record.gate?.kind === "at-time" &&
          record.delivery?.checkBack !== undefined &&
          record.gate.until === record.delivery.checkBack.until;
        const question = decisions.find((card) => !passed.has(card.id));
        const heldGate = record.gate && !gateIsPassed && !reminder ? record.gate : undefined;
        const reason = question
          ? `the open question "${question.title}" needs an answer`
          : wait && !waitIsPassed
            ? `the crewmate is waiting on the captain: ${wait.reason}`
            : heldGate
              ? heldGate.kind === "at-time"
                ? "the task is waiting for its scheduled continuation"
                : heldGate.kind === "quota-reset"
                  ? "the task is waiting for your plan's allowance"
                  : "the task is parked on the captain"
              : undefined;
        if (reason) return `${reason}. ${softHoldWords("decisions", "firstmate")}`;
      }
      lease.sent();
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
        record.pendingSettle.continues ? "continue" : undefined,
        record.pendingSettle.actor === "app" ? "app" : "captain",
      );
    }
  }

  private async landTaskOnce(
    taskId: string,
    actor: MergeActor,
    beforeDispatch?: (head?: string) => string | undefined,
    after?: "close" | "continue",
  ): Promise<SettleOutcome> {
    if (this.locks.working(taskId)) {
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
        plain: `it is already ${describeStatus(record)}`,
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
      // The version the checked story names is the one this merge lands.
      let storyHead: string | undefined;
      if (record.delivery?.presentation) {
        if (!this.host.validateLocalStory)
          throw new Error("The current local story cannot be checked.");
        storyHead = await this.host.validateLocalStory(taskId);
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
      // A question still open on the task keeps it open past the merge (INF-2525).
      const stillOpen = await this.stillOpen(record, undefined, after);
      if (stillOpen) {
        // The receipt says merged, when, and at which version, while the
        // task stays open.
        this.host.tasks.delivery.recordChangeEvidence(taskId, {
          landedMode: mode,
          ...(storyHead ? { landedHead: storyHead } : {}),
          ciAt: this.host.now(),
        });
        const continued = {
          ok: true,
          text: `Merged "${record.title}" into main.`,
          continued: true,
          stillOpen,
        };
        this.finishContinued(taskId, undefined, continued);
        return continued;
      }
      await this.closing.closeTask(taskId, {
        status: "done",
        reason: "landed",
        actor: closeActor(actor),
        delivery: { landedMode: mode, ...(storyHead ? { landedHead: storyHead } : {}) },
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
    actor: MergeActor,
    guard?: MergeGuard,
    beforeDispatch?: (head: string) => string | undefined,
    after?: "close" | "continue",
  ): Promise<SettleOutcome> {
    if (this.locks.working(taskId)) {
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
        plain: `it is already ${describeStatus(record)}`,
      };
    }
    if (!opensPullRequest(this.host.taskDelivery(taskId))) {
      return {
        ok: false,
        text: `Cannot merge: task ${taskId} does not deliver as a pull request; close it with settle_task land.`,
        plain: "it does not deliver as a pull request",
      };
    }
    // The close gate is settleTaskOnce's single check (WI-12).
    if (!this.host.mergePullRequest) {
      // Named by where the project lives (git integration PR 1.3), never
      // assumed to be GitHub.
      return {
        ok: false,
        text: `Cannot merge: ${placeOf(this.host.repos, record, "where the project lives")} is not reachable from here.`,
      };
    }
    await this.approvals.queueMarksSettled(taskId);
    const result = await this.host.mergePullRequest(
      taskId,
      guard,
      beforeDispatch
        ? { beforeDispatch, unattended: actor !== "captain" || guard?.unattended === true }
        : undefined,
    );
    // The answer came: an attempt token has done its job, whatever it said.
    if (guard && result.stop !== "outcome")
      this.approvals.patchStanding(taskId, { attempt: undefined });
    if (!result.ok) {
      // The project's host needs the app's sign-in (git integration PR
      // 1.2): a typed refusal whose ways are the sign-in and keeping the
      // project on this Mac - the Firstmate carries them on one card.
      const refusal = result.signIn ? notSignedInRefusal(record, result.signIn) : undefined;
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
    if (guard) this.approvals.consumeStanding(taskId, result.receipt);
    // Something else on the task is still open (INF-2525): the merge went
    // through and the task stays, for its crewmate to judge what is next.
    const merged = record.delivery?.prNumber;
    const stillOpen = await this.stillOpen(record, merged, after);
    if (stillOpen) {
      const head = result.receipt?.head ?? record.delivery?.headSha;
      this.host.tasks.delivery.recordChangeEvidence(taskId, {
        ci: "merged",
        ...(head ? { headSha: head } : {}),
        ciAt: this.host.now(),
        ciWatch: undefined,
      });
      const continued = { ...result, continued: true, stillOpen };
      this.finishContinued(taskId, undefined, continued);
      return continued;
    }
    return this.closeMerged(record, closeActor(actor), result);
  }

  /**
   * What on the task is still open besides the change that merged
   * (INF-2525), in words its crewmate reads: an open question of its
   * crewmate's or the first mate's, or another of its pull requests that
   * is open or could not be read. Undefined when nothing is, and the merge
   * may close the task. A merge card that declared the task continues
   * past its merge keeps it open by that declaration alone (INF-2744).
   */
  async stillOpen(
    record: TaskRecord,
    merged: number | undefined,
    after?: "close" | "continue",
  ): Promise<string | undefined> {
    if (after === "continue") return "its merge card said the task continues after this merge";
    const question = [...this.host.cards.values()].find(
      (card) => card.taskId === record.id && keepsTaskOpen(card),
    );
    if (question) return `the card "${question.title}" on this task is still open`;
    // An approved merge of another of its pull requests waits its turn (INF-2746).
    const approved = record.delivery?.mergeAuthorization;
    const waiting = [
      ...(approved?.status === "standing" ? [approved] : []),
      ...(approved?.queued ?? []),
    ].find((item) => item.target.prNumber !== merged);
    if (waiting)
      return `the approved merge of ${changeName(record, waiting.target.prNumber)} on this task has not run yet`;
    if (merged === undefined) return undefined;
    const open = await this.otherOpenChange(record, merged);
    if (!open) return undefined;
    return `${changeName(record, open.number)} on this task ${open.unread ? "could not be read, so it may still be open" : "is still open"}`;
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
      !opensPullRequest(this.host.taskDelivery(taskId)) ||
      this.locks.holder(taskId)
    )
      return false;
    const lease = this.locks.claim(taskId, "merge-pr");
    try {
      const pull = await this.mergedOutside(record);
      const current = this.host.tasks.get(taskId);
      // A close or a different project/change took over while the read was out.
      if (
        !pull ||
        !current ||
        TaskService.isClosed(current) ||
        current.repoId !== record.repoId ||
        currentChange(current.delivery, current.branch).number !== pull.number
      )
        return false;
      this.host.tasks.delivery.recordChangeEvidence(taskId, {
        ci: "merged",
        headSha: pull.headSha,
        ciAt: this.host.now(),
        ciWatch: undefined,
      });
      // Another of its pull requests still open keeps the task open (INF-2525).
      const other = await this.otherOpenChange(current, pull.number);
      if (
        other !== undefined ||
        !this.declaresClose(current, pull) ||
        this.locks.working(taskId) ||
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
        closeGateRefusal(this.host, taskId, "merge-pr", false)
      ) {
        const once = `external-merge:${pull.number}:${pull.headSha}`;
        if (!this.host.inbox.woken(taskId, once)) {
          this.host.inbox.enqueueSteerOnce(taskId, {
            facts: {
              kind: "external-merge",
              ...(taskContributesUpstream(
                current,
                current.repoId ? this.host.repos.get(current.repoId) : undefined,
              )
                ? { contribution: true }
                : {}),
              change: changeName(current, pull.number),
              head: pull.headSha,
              ...(other
                ? {
                    open: `${changeName(current, other.number)} on this task ${other.unread ? "could not be read, so it may still be open" : "is still open"}`,
                  }
                : {}),
            },
            once,
          });
        }
        return true;
      }
      await this.closeMergedOutside(taskId, "host", pull);
      return true;
    } finally {
      lease.release();
    }
  }

  /**
   * Whether the task's open merge card for this pull request declared that
   * its merge closes the task, at the version that merged (INF-2744): the
   * card's own declaration is the one writer of that fact. A merge card
   * the app approved on its own reads through its standing approval.
   */
  private declaresClose(record: TaskRecord, pull: ForgePull): boolean {
    if (
      taskContributesUpstream(
        record,
        record.repoId ? this.host.repos.get(record.repoId) : undefined,
      ) &&
      record.delivery?.completionOffers?.some(
        (offer) =>
          offer.prNumber === pull.number &&
          offer.headSha === pull.headSha &&
          offer.presentationRevision !== undefined &&
          offer.continues !== true,
      )
    )
      return true;
    // Every open merge card that names this pull request (INF-2746): a
    // review of it, or the task's own change.
    const scopes = [
      ...(record.delivery?.mergeReviews ?? [])
        .filter((item) => item.number === pull.number)
        .map((item) => ({ review: item.id })),
      { review: undefined },
    ];
    for (const scope of scopes) {
      const open = this.host.cards.openMergeAction(record.id, scope);
      if (open?.after !== "close") continue;
      if (open.review) {
        const review = record.delivery?.mergeReviews?.find((item) => item.id === open.review);
        if (review?.headSha === pull.headSha) return true;
        continue;
      }
      const offer = record.delivery?.completionOffers?.find(
        (entry) => entry.cardId === open.cardId,
      );
      if ((offer?.shownFor ?? offer?.prNumber) === pull.number && offer?.headSha === pull.headSha)
        return true;
    }
    const authorization = standingAuthorization(record.delivery);
    if (!authorization || authorization.target.prNumber !== pull.number) return false;
    return (authorization.after ?? (authorization.review ? "continue" : "close")) === "close";
  }

  /**
   * The task's current change, when it reads merged by its number: put in
   * where the project lives outside the app (FI3-213). Undefined when there
   * is none, it is not merged, or it cannot be read.
   */
  private async mergedOutside(record: TaskRecord): Promise<ForgePull | undefined> {
    const prNumber = currentChange(record.delivery, record.branch).number;
    if (prNumber === undefined || !this.host.readPull) return undefined;
    const pull = await this.host.readPull(record.id, prNumber).catch(() => undefined);
    return pull?.merged && pull.number === prNumber ? pull : undefined;
  }

  /**
   * One of the task's other changes that may still be open where the
   * project lives (INF-2490): every pull request its record keeps a change
   * for, and every one its slot names, besides the merged one, read by its
   * number. A task closes as merged on an earlier merge only when none is
   * open; one that cannot be read may be open, so it keeps the task open
   * too (`unread`).
   */
  private async otherOpenChange(
    record: TaskRecord,
    merged: number,
  ): Promise<{ number: number; unread: boolean } | undefined> {
    if (!this.host.readPull) return undefined;
    return this.openChangeAmong(record, merged);
  }

  /**
   * Every pull request number the task's record keeps: its changes not yet
   * merged, its slot, its merge reviews and its completion offers.
   */
  pullNumbersOf(record: TaskRecord): Set<number> {
    const numbers = new Set<number>();
    for (const change of this.host.tasks.changesFor(record.id))
      if (change.handle?.number !== undefined && change.receipt?.outcome !== "merged")
        numbers.add(change.handle.number);
    if (record.delivery?.prNumber !== undefined) numbers.add(record.delivery.prNumber);
    for (const review of record.delivery?.mergeReviews ?? [])
      if (!review.receipt) numbers.add(review.number);
    for (const offer of record.delivery?.completionOffers ?? [])
      if (offer.prNumber !== undefined) numbers.add(offer.prNumber);
    return numbers;
  }

  /**
   * The first of the task's pull requests, besides `except`, that reads open
   * or cannot be read where the project lives; undefined when every one
   * reads closed or merged. Without a way to read them, each one is unread.
   */
  async openChangeAmong(
    record: TaskRecord,
    except?: number,
  ): Promise<{ number: number; unread: boolean } | undefined> {
    const readPull = this.host.readPull;
    const numbers = this.pullNumbersOf(record);
    if (except !== undefined) numbers.delete(except);
    for (const number of numbers) {
      const pull = readPull ? await readPull(record.id, number).catch(() => undefined) : undefined;
      if (pull?.number !== number) return { number, unread: true };
      if (pull.state === "open" && !pull.merged) return { number, unread: false };
    }
    return undefined;
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
    if (this.locks.working(taskId)) {
      return {
        ok: false,
        text: "Cannot merge yet: the crewmate is still working; wait for its report or interrupt it first.",
      };
    }
    const record = this.host.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    return this.closeMerged(record, actor, {
      ok: true,
      text: `${changeName(record, pull.number)} is already merged on ${placeOf(this.host.repos, record)}.`,
      ...mergedOnLine(changeName(record, pull.number), placeOf(this.host.repos, record, "")),
      receipt: mergedReceipt(pull),
    });
  }

  /**
   * A merged task's close: the record, the managed checkout, and the gates
   * it releases. `data` is more for the close to record, such as a done
   * close's delivery facts.
   */
  async closeMerged(
    record: TaskRecord,
    actor: TaskClose["actor"],
    result: PrOutcome,
    data?: Record<string, unknown>,
  ): Promise<SettleOutcome> {
    const taskId = record.id;
    await this.closing.closeTask(
      taskId,
      {
        status: "done",
        reason: "merged",
        actor,
        text: result.text,
        // Activity's line for the merge: the change and where it went in,
        // never its address (INF-1845).
        ...(result.line || data
          ? {
              data: {
                ...data,
                ...(result.line ? { line: result.line } : {}),
                ...(result.line && result.lineSaid ? { lineSaid: result.lineSaid } : {}),
              },
            }
          : {}),
        delivery: {
          landedMode: "pr",
          ...(result.receipt?.sha ? { mergedSha: result.receipt.sha } : {}),
        },
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
   * and the sentence returns for the settle's own text. Its note is the
   * task's warning line in Activity, beside the merge's own line, whoever
   * merged (INF-1845).
   */
  private folderNotUpdated(
    record: TaskRecord,
    _actor: TaskClose["actor"],
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
      feed: true,
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
   * A reviewed pull request merged (INF-2744): its merge card declared what
   * follows. A close closes the task as merged once nothing else on it is
   * open; otherwise the task continues and its crewmate hears the merge once.
   */
  async finishReviewMerge(
    taskId: string,
    review: MergeReview | undefined,
    result: SettleOutcome,
    after: "close" | "continue",
    actor: MergeActor,
  ): Promise<SettleOutcome & { continued?: boolean }> {
    const record = this.host.tasks.get(taskId);
    const stillOpen =
      after === "close" && record
        ? (this.closeHeld(record, review) ?? (await this.stillOpen(record, review?.number)))
        : "continue";
    if (!record || stillOpen) {
      const continued = {
        ...result,
        continued: true,
        ...(stillOpen && after === "close" ? { stillOpen } : {}),
      };
      this.finishContinued(taskId, review, continued);
      return continued;
    }
    const authorization = standingAuthorization(record.delivery);
    if (review && authorization?.review?.id === review.id)
      this.approvals.consumeStanding(taskId, result.receipt);
    return this.closeMerged(record, closeActor(actor), {
      ok: true,
      text: result.text,
      ...(result.receipt ? { receipt: result.receipt } : {}),
    });
  }

  /**
   * What keeps a task open after a review's merge that declared it closes,
   * by the same rules as the task's own merge (INF-2746): its crewmate
   * still working, or the close rules - open parts the merge card did not
   * leave planned, or a task it waits on.
   */
  private closeHeld(record: TaskRecord, review: MergeReview | undefined): string | undefined {
    if (this.locks.working(record.id)) return "its crewmate is still working";
    const authorization = standingAuthorization(record.delivery);
    const proceedWithOpen =
      review !== undefined && authorization?.review?.id === review.id
        ? authorization.proceedWithOpen
        : false;
    const gate = closeGateRefusal(this.host, record.id, "merge-pr", proceedWithOpen);
    if (!gate) return undefined;
    return gate.refused === "waits-on"
      ? "it still waits on another task to finish"
      : "parts of it are still open";
  }

  finishContinued(taskId: string, review: MergeReview | undefined, result: SettleOutcome): void {
    // A story note held for the merge shows once the settle ends: the
    // card stack draws its merged line from the change's receipt (INF-2678).
    this.host.tasks.atomic(
      () => {
        const authorization = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
        if (
          review &&
          authorization?.review?.id === review.id &&
          candidateHead(authorization) === result.receipt?.head
        )
          this.approvals.consumeStanding(taskId, result.receipt);
        else if (review && authorization?.review?.id === review.id)
          this.approvals.endAuthorization(
            taskId,
            "invalidated",
            "the pull request merged at a different version",
            { feed: true },
          );
        this.host.tasks.delivery.activateRequiredActions(taskId);
        this.host.tasks.delivery.activateAfterMergeSteps(taskId);
        this.host.tasks.note(taskId, result.text, { news: true, feed: true, actor: "host" });
      },
      () => {},
    );
    // The committed task note already reaches Activity through the task-event seam.
    this.host.mergeContinued?.(taskId, review, result);
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
    return result.text;
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
    // The first mate's own merge hears what it filed in its tool result, as
    // the captain's click's wake says it (INF-2796).
    const merged = result.ok && mode !== "discard";
    const afterMerge = merged ? this.host.tasks.delivery.filedAfterMergeSteps(taskId) : [];
    const firstmateSteps = merged ? this.host.tasks.delivery.firstmateAfterMergeSteps(taskId) : [];
    return {
      text:
        afterMerge.length || firstmateSteps.length
          ? `${result.text} ${afterMergeWords(afterMerge, firstmateSteps)}`
          : result.text,
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
  async settleTaskGuarded(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm: boolean | undefined,
    actor: MergeActor,
    proceedWithOpen = false,
    guard?: MergeGuard,
    after?: "close" | "continue",
  ): Promise<SettleOutcome> {
    const pending = this.locks.holder(taskId);
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
        text: `Task ${taskId} "${record.title}" builds in place on the personal workspace: its changes are already there and committed, so there is nothing to merge, land, or discard. Close it with settle_task done, why finished and evidence once its report is verified${
          this.host.runtimeState(taskId) ? ", or interrupt it with mode cancel to stop it" : ""
        }. ${fixedHoldWords("nothing-to-merge")}`,
        plain: `it builds in place on your personal workspace, so there is nothing to ${mode === "discard" ? "discard" : "merge"}`,
      };
    }
    // A discard is the one drop, by its rules (INF-3169's piece 4).
    if (mode === "discard")
      return this.drops.drop(taskId, {
        actor: actor === "captain" ? "captain" : "firstmate",
        reason: "discarded",
        ...(confirm ? { confirm } : {}),
        ...(proceedWithOpen ? { proceedWithOpen } : {}),
      });
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
          text: `Nothing to merge: this task delivers an operation, not code. Verify the effect and close it done, why finished with evidence. ${fixedHoldWords("nothing-to-merge")}`,
          plain: "it delivers an operation, not code, so there is nothing to merge",
        };
      if (this.host.deliverableOf(record) === "answer") {
        return {
          ok: false,
          text: `Nothing to ${mode === "merge-pr" ? "merge" : "land"}: task ${taskId} "${record.title}" delivers an answer, not a change - it commits nothing and opens no pull request, and its card is the deliverable. It closes when the captain resolves that card, or with settle_task done, why answered once its answer is handed on. ${fixedHoldWords("nothing-to-merge")}`,
          plain: "it delivers an answer, not a change, so there is nothing to merge",
        };
      }
    }
    // One owner across cards, the shell, and conversational tools. Claim
    // before the first await, and retain it through worktree cleanup.
    const lease = this.locks.claim(taskId, mode);
    const boundary = this.mergeBoundary(lease, taskId, mode, actor, proceedWithOpen);
    try {
      if (mode === "merge-pr" || mode === "land") {
        const existing = this.host.tasks.get(taskId)?.pendingSettle;
        const presentation = this.host.tasks.get(taskId)?.delivery?.presentation;
        const destination = presentation?.revisions.at(-1)?.destination;
        const story =
          destination && !hostedPresentation(destination)
            ? readyPresentation(presentation)
            : undefined;
        const waited = await lease.waitForTurnEnd(
          existing ?? {
            mode,
            actor,
            requestedAt: this.host.now(),
            proceedWithOpen,
            ...(after === "continue" ? { continues: true as const } : {}),
            ...(story ? { story } : {}),
          },
        );
        if (!waited.ended)
          return {
            ok: false,
            text: `Cannot ${mode} task ${taskId}: ${waited.cancelled} while it waited for its crewmate's turn to end.`,
            plain: `${waited.cancelled} while its crewmate was working`,
          };
      }
      return await this.settleTaskOnce(
        taskId,
        mode,
        confirm,
        actor,
        proceedWithOpen,
        guard,
        boundary,
        after ?? this.declaredThen(taskId, actor),
      );
    } finally {
      if (mode === "merge-pr" || mode === "land") {
        const record = this.host.tasks.get(taskId);
        if (record?.pendingSettle) this.host.tasks.delivery.setPendingSettle(taskId, null);
      }
      lease.release();
    }
  }

  private async settleTaskOnce(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    _confirm: boolean | undefined,
    actor: MergeActor,
    proceedWithOpen: boolean,
    guard?: MergeGuard,
    boundary?: (head?: string) => string | undefined,
    after?: "close" | "continue",
  ): Promise<SettleOutcome> {
    const record = this.host.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    if (record.kind === "decision") {
      throw new Error(`Task ${taskId} is a decision, not crew work.`);
    }
    // The close rules (P2): every settle mode closes the record. A structured
    // refusal carries its ways out (WI-12); the prose still leads the result.
    const gateRefusal = closeGateRefusal(this.host, taskId, mode, proceedWithOpen);
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
    // A first mate merge of a change already merged where the project
    // lives sends nothing: the task closes as merged, with autonomy on or
    // off, once none of its changes is still open (FI3-213, INF-2490).
    if (mode === "merge-pr" && actor === "firstmate") {
      const pull = await this.mergedOutside(record);
      // Its question, or another of its pull requests, still open keeps the
      // task open too (INF-2525).
      const stillOpen = pull ? await this.stillOpen(record, pull.number, after) : undefined;
      if (pull && stillOpen !== undefined) {
        return {
          ok: false,
          text: `Cannot close as merged: ${changeName(record, pull.number)} is merged, and ${stillOpen}. The task closes as merged once nothing else on it is open; its crewmate judges what comes next.`,
          plain: "something else on the task is still open",
        };
      }
      if (pull) return this.closeMergedOutside(taskId, actor, pull);
    }
    if (mode === "merge-pr" || mode === "land") {
      // The one merge gate, before anything merges or lands.
      const held = this.mergeRefusal(record, mode, actor);
      if (held) return { ok: false, text: held.text, refusal: held };
    }
    if (mode === "merge-pr") {
      return this.mergePrTaskOnce(taskId, actor, guard, boundary, after);
    }
    if (mode === "land") {
      return this.landTaskOnce(taskId, actor, boundary, after);
    }

    throw new Error(`Task ${taskId}: ${mode} is not a merge or a land.`);
  }

  /**
   * What the open merge card declared follows the merge, for a merge whose
   * caller named none: the first mate's merge call carries the card's own
   * declaration (INF-2744). Undefined leaves the old rule: the merge closes
   * the task unless something else on it is still open.
   */
  private declaredThen(taskId: string, actor: MergeActor): "close" | "continue" | undefined {
    // Only the app's own merge from a card follows that card's declaration
    // (INF-2744); the captain's and the first mate's merges keep theirs.
    if (actor !== "app") return undefined;
    const record = this.host.tasks.get(taskId);
    return record ? openCurrentMerge(this.host, record)?.after : undefined;
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

  /** Every detached settle is awaited here; refusal text is an outcome too, and it answers the outcome. */
  async reportCardSettle(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm?: boolean,
    proceedWithOpen?: boolean,
    after?: "close" | "continue",
    actor: "captain" | "app" = "captain",
  ): Promise<SettleOutcome> {
    const record = this.host.tasks.get(taskId);
    const title = record?.title ?? taskId;
    if (!this.locks.holder(taskId) && record) {
      const waitsForTurn = (mode === "merge-pr" || mode === "land") && this.locks.working(taskId);
      const number = record.delivery?.prNumber;
      const change =
        mode === "merge-pr" && number !== undefined ? changeName(record, number) : undefined;
      this.settleLine(taskId, settlingSaid(mode, change, waitsForTurn));
    }
    // The click's own approval, minted with its card resolution (FI3-304):
    // this attempt merges only the head that approval covers.
    const authorization =
      mode === "merge-pr"
        ? standingAuthorization(this.host.tasks.get(taskId)?.delivery)
        : undefined;
    if (authorization) await this.approvals.storeApprovalReading(taskId, authorization);
    let result: SettleOutcome;
    try {
      result = await this.settleTaskGuarded(
        taskId,
        mode,
        confirm,
        actor,
        proceedWithOpen ?? authorization?.proceedWithOpen ?? false,
        authorization ? this.approvals.guardOf(taskId, authorization, false) : undefined,
        after ?? authorization?.after,
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
    const kept = authorization
      ? this.approvals.afterAttempt(taskId, authorization, result)
      : undefined;
    if (kept) {
      const place = placeOf(this.host.repos, this.host.tasks.get(taskId));
      result = {
        ...result,
        text: `${result.text}\n\n${keptNote(kept.wait, kept.head, place, currentCheckStatus(this.host.tasks.get(taskId)?.delivery), this.approvals.queueWarning(taskId, kept.wait), this.approvals.queueOwnsMerge(taskId))}`,
      };
    }
    // Only the captain's own click leaves them with no card to read (INF-2913).
    const clicked = actor === "captain" && authorization?.issuer !== "autonomy";
    this.reportOutcome(taskId, title, mode, confirm, result, kept?.wait, clicked);
    return result;
  }

  /**
   * A settle's line in Activity, on its task's record so it carries the
   * task's key: the click, then whatever became of it, each taking the
   * last one's place (`SETTLE_FOLD`, INF-1845).
   */
  settleLine(taskId: string, line: string | Said): void {
    if (!this.host.tasks.get(taskId)) return;
    // A line in the app's words is saved as a fact beside its English (docs/i18n.md, "Saved facts").
    const fact = typeof line === "string" ? undefined : line;
    this.host.tasks.note(taskId, fact ? englishOf(fact) : (line as string), {
      news: true,
      feed: true,
      data: { feedLine: true, feedOnce: SETTLE_FOLD, ...(fact ? { said: fact } : {}) },
    });
  }

  /** The feed's receipt of a settle and the wake that makes a refusal actionable. */
  reportOutcome(
    taskId: string,
    title: string,
    mode: "merge-pr" | "land" | "discard",
    confirm: boolean | undefined,
    result: SettleOutcome,
    kept: MergeWait | undefined,
    clicked = true,
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
    // The click's line on the task's record gives way to its outcome
    // (`SETTLE_FOLD`, INF-1845). A merge that closed the task already has
    // its line: the close's own ("Merged #709 on GitHub"), and so has a
    // discard that closed it with nothing more to say ("Discarded").
    const record = this.host.tasks.get(taskId);
    const merged =
      (result.ok && result.continued) ||
      (result.ok &&
        record &&
        TaskService.isClosed(record) &&
        (mode !== "discard" || (!result.problem && !result.plain)));
    if (kept)
      this.settleLine(
        taskId,
        keptFeedSaid(
          kept,
          placeOf(this.host.repos, record, ""),
          currentCheckStatus(record?.delivery),
          this.approvals.queueOwnsMerge(taskId),
        ),
      );
    // Contention settled nothing: the attempt that owns the task says what became of it.
    else if (!merged && !result.contention) this.settleLine(taskId, settleFeedSaid(mode, result));
    // A healthy queue wait needs no decision, card or first mate turn.
    // An unanswered queue's warning still needs an agent to recover it.
    if (kept === "queue" && this.approvals.queueWarning(taskId, kept) === undefined) return;
    // A merge that went through is the feed line above and nothing more,
    // unless it freed work only a start begins (friction 7 of the
    // captain's Oct 22 audit: 45 of 62 merge wakes were idle turns).
    // It also wakes once when the merge filed its story's after-merge steps
    // (INF-2796), so the first mate can drop one another task already covers.
    // A step its story left to the first mate, a change in the app, wakes it
    // too: no task holds that step, so the wake is its one hand-over.
    const wentThrough = result.ok && mode !== "discard";
    const afterMerge = wentThrough ? this.host.tasks.delivery.filedAfterMergeSteps(taskId) : [];
    const firstmateSteps = wentThrough
      ? this.host.tasks.delivery.firstmateAfterMergeSteps(taskId)
      : [];
    if (
      wentThrough &&
      afterMerge.length === 0 &&
      firstmateSteps.length === 0 &&
      !this.freesWorkAwaitingStart(taskId)
    )
      return;
    this.wakeOnSettle(
      taskId,
      title,
      confirm ? `${mode} (confirmed)` : mode,
      { ...result, text: result.text },
      afterMerge,
      clicked,
      firstmateSteps,
    );
  }

  /**
   * Whether this merged task held open work that now waits on nothing and
   * that the ready sweep will not start - on request, or held by a gate
   * (`TaskService.graph.awaitsStart`). Only the Firstmate or the captain begins
   * it, and a task the Firstmate linked to wait on this merge - one its
   * report says it covers - is such work, so its after-merge check runs.
   * An active waiter needs no wake: the ready sweep steers it when this
   * task closes (`dependency-closed`).
   */
  private freesWorkAwaitingStart(taskId: string): boolean {
    const tasks = this.host.tasks;
    return tasks.graph
      .blocking(taskId)
      .some(
        (record) =>
          record.status === "open" &&
          tasks.graph.waitingOn(record.id).length === 0 &&
          tasks.graph.awaitsStart(record),
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
   *
   * A merge that did not go through raises no card of the host's own
   * (INF-2913): the captain sees only its Activity line, so the wake marks
   * it `unseen` and the Firstmate raises a card only when the next step is
   * the captain's. `clicked` false is the app's own merge under autonomy
   * (INF-2744): no click was made and its card is back up, so it is not
   * marked.
   */
  wakeOnSettle(
    taskId: string,
    title: string,
    chose: string,
    result: SettleOutcome,
    afterMerge: FiledAfterMergeStep[] = [],
    clicked = true,
    firstmateSteps: FirstmateAfterMergeStep[] = [],
  ): void {
    if (result.contention) return;
    this.host.notifyOp(
      {
        facts: {
          kind: "settled",
          task: { id: taskId, title },
          chose,
          outcome: result.text,
          // A clicked merge that did not go through shows the captain no
          // card of the host's own (INF-2913): the wake says so.
          ...(clicked && !result.ok && !chose.startsWith("discard")
            ? { unseen: true as const }
            : {}),
          ...(result.refusal ? { refusal: result.refusal } : {}),
          ...(afterMerge.length ? { afterMerge } : {}),
          ...(firstmateSteps.length ? { firstmateSteps } : {}),
        },
      },
      "agent",
      taskId,
    );
  }
}

/** Who a close names: the app's own merge is the host's. */
function closeActor(actor: MergeActor): TaskClose["actor"] {
  return actor === "app" ? "host" : actor;
}
