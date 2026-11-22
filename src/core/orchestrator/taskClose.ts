import {
  bodyHeadings,
  COMPLETION_CARD_HEADINGS,
  TIERED_STORY_HEADINGS,
} from "@shared/cardHeadings";
import type { Card, ChoiceCarriedRecord } from "@shared/cards";
import { plainProblem, type TypedFailure } from "@shared/plainProblem";
import { opensPullRequest } from "@shared/repos";
import type { TaskDeliveryMode } from "@shared/tasks";
import { mergingClose } from "../storage/changeProjection";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { keptWorkWords, type TaskWorkspace } from "../workspace/workspaceService";
import { answersByShape, type ClosingPlace } from "./askEnding";
import type { AnswerTaskClosedPayload } from "./captainWakes";
import { escapeCardText } from "./cardText";
import type { PrOutcome } from "./changeMerge";
import type { KeptApproval } from "./keptApproval";
import { endedAuthorization, standingAuthorization } from "./mergeAuthorization";
import type { SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import {
  type ClosedWithoutClick,
  changeName,
  closedLine,
  closedWithoutClick,
  closingNoteTitle,
  mergedLine,
  mergePendingCardId,
  pullLeftOpenText,
  withCloseLine,
  withMergeLine,
} from "./settleWords";

export function workspaceOf(record: TaskRecord): TaskWorkspace {
  return {
    taskId: record.id,
    cwd: record.worktreeDir,
    branch: record.branch,
    repoDir: record.repoDir,
  };
}

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
  /** Who closed it; a crewmate closes only the parts of a program it stopped. */
  actor: "captain" | "firstmate" | "crewmate" | "host";
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
  /** What else the captain's closing choice carried, which the first mate's notice brings along. */
  answerCarried?: ChoiceCarriedRecord;
  /** Extra facts the close records on its timeline event. */
  data?: Record<string, unknown>;
  /**
   * A drop of a task already closed whose copy was kept, because its work
   * could not be saved: the one close that removes that copy (`TaskDrop`).
   */
  removeKept?: boolean;
};

type ClosingReason = TaskClose["reason"] | "failed";

/**
 * A card that told the captain how the work came out: shaped as its outcome
 * (`answersByShape`), or a crewmate's card opening with a completion
 * story's headings, read from the markup as the card lint reads them.
 */
function toldOutcome(card: Card): boolean {
  if (answersByShape(card)) return true;
  if (card.author !== "crewmate") return false;
  const headings = bodyHeadings(card.body);
  return [COMPLETION_CARD_HEADINGS, TIERED_STORY_HEADINGS].some((outline) =>
    outline.every((heading, index) => headings[index] === heading),
  );
}

/**
 * How a task closes (the primitives review's P6, docs/task-record.md): its
 * record, its lane and queued wakes in one transaction (`closeAndPurge`),
 * its cards off the stack, the first mate's closing sentence and where the
 * outcome goes, its worktree retired with unlanded work saved first, and its
 * delivery children after it.
 */
export class TaskClosing {
  constructor(
    private readonly host: SettleServiceHost,
    private readonly locks: SettleLocks,
    private readonly approvals: KeptApproval,
  ) {}

  private readonly retirements = new Map<string, Promise<"removed" | "kept" | "none">>();

  /**
   * The first mate's closing sentence for a task it is closing now
   * (INF-547): the one sentence the captain reads about started work that
   * closed without their click. Only the first mate's own close tools set
   * one, so a captain's click never carries it; the close that follows
   * takes it (`takeClosingSentence`).
   */
  private readonly closingSentences = new Map<string, string>();

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
   * Where a close of started work puts what became of it (INF-1610's at
   * most one closing note, docs/task-capture.md "How a message ends"). The
   * captain's message the work covers decides, never the close's words, and
   * a card speaks only for its own task (INF-6115):
   * - a card of the closed task that is still up and answers the message
   *   is revised with the outcome - the merge line on a merge;
   * - a card of the task they already chose on or closed never comes back
   *   (the captain's pick on INF-6115, and INF-2718 for a note): work they
   *   chose that was dropped after all, by someone other than them, gets
   *   its own closing note instead;
   * - other work of the message still running, or the task that took this
   *   work over, keeps it quiet;
   * - a message already answered, or waiting on a card of other work,
   *   leaves that card as it is: a drop, merge or release with the first
   *   mate's sentence gets its own closing note named for the task, when no
   *   card of the task is up, and a finish stays quiet;
   * - otherwise the first mate's sentence goes up as the app's one closing
   *   note, marked as the answer.
   * Work no message of the captain's covers - work the fleet started on
   * its own - puts a note up only when code merged or was released, only
   * when nothing of the task is still on their stack, and only when they
   * never closed its story or completion card.
   */
  placeOutcome(
    record: TaskRecord,
    reason: string,
    actor: TaskClose["actor"],
    sentence: string | undefined,
  ): void {
    const outcome = closedWithoutClick(reason);
    if (!outcome || record.startedAt === null) return;
    // Work that merged on its own with a story note says so there: the card
    // stack draws its merged line, with the first mate's sentence, from the
    // change's receipt, so no other card takes it and no second note goes up
    // (INF-2678, the captain's pick: the note's merged line only).
    if (
      mergingClose(reason) &&
      [...this.host.cards.values()].some(
        (card) => card.taskId === record.id && this.host.cards.drawsMergedLine(card),
      )
    )
      return;
    // Work the first mate declared the captain did not ask for raises
    // nothing new on their stack (INF-1467): a card of its that is up still
    // takes the outcome, and a message it served gets its answer from the
    // first mate step.
    const asked = this.host.askEnding.closingPlace(record.id);
    let place: ClosingPlace =
      !record.shape?.internal_step || asked.kind === "unasked"
        ? asked
        : asked.kind === "revise" && asked.open
          ? asked
          : { kind: "unasked" };
    const answer =
      place.kind === "revise"
        ? place
        : place.kind === "unasked" && place.card
          ? { card: place.card, open: true }
          : undefined;
    if (answer?.open) {
      if (outcome !== "merged" && !sentence) return;
      this.reviseAnswer(answer.card, record, outcome, actor, sentence);
      return;
    }
    if (answer) {
      // A note the captain closed stays closed (INF-2718, DOP-201's note
      // raised again with its "dropped" line), and a decision they chose on
      // is never raised again (INF-6115): the close stays on the task's
      // record and in Activity; only a drop they did not make gets a note.
      if (answer.card.actions.length === 0) return;
      if (outcome !== "dropped" || actor === "captain") return;
      place = { kind: "note", answering: false };
    }
    if (!sentence || place.kind === "quiet" || place.kind === "revise") return;
    const unasked = place.kind === "unasked";
    // A note beside the message's answer tells only what the captain did
    // not see happen: a drop, merge or release, never a finish.
    const beside = place.kind === "unasked" || !place.answering;
    if (unasked && outcome !== "merged" && outcome !== "released") return;
    if (beside && outcome === "finished") return;
    if (beside && [...this.host.cards.values()].some((card) => card.taskId === record.id)) return;
    // The captain already closed or chose on the task's story or completion
    // card: that card was its one note, so no second note goes up beside it
    // (INF-2461, the captain's pick on INF-2442). A drop they did not make
    // is news that card never told, so it still gets its note (INF-6115).
    if (
      beside &&
      outcome !== "dropped" &&
      this.host.cards.closedByCaptain(record.id).some(toldOutcome)
    )
      return;
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
      aboutTask: true,
      ...(beside ? {} : { answering: true }),
    });
  }

  /**
   * A card of the closed task still up for the captain, revised with what
   * became of its work: on a merge the merge line - when, its pull request
   * and the first mate's sentence (INF-1219) - else the close line.
   */
  private reviseAnswer(
    card: Card,
    record: TaskRecord,
    outcome: ClosedWithoutClick,
    actor: TaskClose["actor"],
    sentence: string | undefined,
  ): void {
    const current = this.host.tasks.get(record.id) ?? record;
    const delivery = current.delivery;
    const label =
      delivery?.prNumber !== undefined
        ? `PR ${changeName(current, delivery.prNumber)}`
        : delivery?.changeLabel;
    const body =
      outcome === "merged"
        ? withMergeLine(
            card.body,
            mergedLine({
              at: this.host.now(),
              onItsOwn: actor !== "captain",
              ...(label
                ? { change: { label, ...(delivery?.prUrl ? { url: delivery.prUrl } : {}) } }
                : {}),
              ...(sentence ? { sentence } : {}),
            }),
          )
        : withCloseLine(card.body, closedLine(record.key || record.id, outcome, sentence));
    this.host.cards.reviseBody(card.id, body);
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
    if (!opensPullRequest(this.host.taskDelivery(taskId)) || !this.host.closePullRequest) {
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
   * Settle a task: the crewmate stops, the worktree and branch go, the
   * lane and open cards retire, and the RECORD CLOSES - its row, timeline
   * and session JSONL under crewmates/<taskId> stay (captain decision D2:
   * "the sessions are very valuable ... we shouldn't remove the entire
   * session JSONL altogether"). The worktree vanishing is the externally
   * observable "settled" signal (the phase3 e2e polls for it), so the
   * record closes before it goes.
   *
   * Each synchronous part runs as a named step (`host.step`), so the freeze
   * recorder tags a stall with the part running and times each part
   * (docs/freeze-recorder.md, "A task's close").
   */
  async closeTask(
    taskId: string,
    close: TaskClose,
    options: { recordBeforeStop?: boolean } = {},
  ): Promise<void> {
    const step = this.host.step ?? (<T>(_name: string, run: () => T): T => run());
    // A promise this close awaits comes back wrapped, so its step times only
    // the synchronous start and leaves a rejection to this close.
    const { stopping } = step("close-stop", () => {
      // This task settlement announces its reach before stopping the runtime;
      // the crewmate leaves after that spark. A superseded one instead hands
      // over to its successor, whose start is its spark.
      // Work carried on closes done and goes home like any done task.
      if (close.reason !== "superseded" || close.status === "done") {
        this.host.announceReach?.(taskId);
      }
      this.host.killJobs?.(taskId);
      this.host.endLiveTask(taskId);
      return { stopping: this.host.stopRuntime(taskId) };
    });
    if (stopping && !options.recordBeforeStop) {
      await stopping;
      this.locks.turnEnded(taskId);
    }
    let record = this.host.tasks.get(taskId);
    record = step("close-approvals", () => this.leaveLine(taskId, record, close.reason));
    // The lane and every queued wake retire with the task, in the close's
    // own transaction: a settled task makes still-recorded guidance moot.
    // A row already done or dropped keeps its close; a discard there only
    // clears the worktree it kept (WI-7).
    let answerHandoffQueued = false;
    let sentence: string | undefined;
    step("close-record", () => {
      if (!record || record.status === "done" || record.status === "dropped") {
        this.host.inbox.purgeTask(taskId);
        return;
      }
      const open = record;
      sentence = this.takeClosingSentence(taskId, close.actor);
      const data =
        close.data || close.answerHandoff || sentence
          ? {
              ...close.data,
              ...(close.answerHandoff ? { choice: close.answerHandoff.choice.label } : {}),
              ...(sentence ? { closingSentence: sentence } : {}),
            }
          : undefined;
      this.closeAndPurge(
        [taskId],
        () => {
          this.endApprovals(open, close.reason);
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
                {
                  facts: {
                    kind: "answer-closed",
                    handoff: close.answerHandoff,
                    ...(close.answerCarried ? { carried: close.answerCarried } : {}),
                  },
                },
                "agent",
                taskId,
              ) !== null;
          }
        },
        stopping,
      );
    });
    // External observation closes at the synchronous idle boundary, before
    // stopping can yield: new guidance must see a closed record, not be purged
    // later after it was accepted on a task that still appeared open.
    if (stopping && options.recordBeforeStop) {
      await stopping;
      this.locks.turnEnded(taskId);
    }
    // The durable handoff becomes visible only after its close transaction;
    // poking here cannot race the lane purge that precedes its insertion.
    if (answerHandoffQueued) this.host.pokeInbox();
    step("close-cards", () => {
      this.host.cards.retireTaskCards(taskId, close.reason, {
        keepNotes: close.status === "done",
      });
      if (record && record.status !== "done" && record.status !== "dropped") {
        this.placeOutcome(record, close.reason, close.actor, sentence);
      }
      // A kept note still waiting on the crewmate shows now, once the close
      // is recorded: a story note's merged line is already drawn from the
      // change's receipt (INF-2533, INF-2678).
      this.host.cards.releaseNotes(taskId);
    });
    step("close-asks", () => this.host.asksMoved?.());
    step("close-broadcast", () => {
      this.host.cards.scheduleBroadcast();
      this.host.broadcastCrewCounts();
    });
    // Its stops run and the programs holding its folders end before they go.
    await this.host.leftovers?.settled(taskId);
    const closed = record;
    if (closed?.worktreeDir && closed.workspaceState !== "removed") {
      // Every close keeps a copy whose work cannot be saved (INF-3169's one
      // drop); only dropping the closed task again removes it.
      const { retiring } = step("close-worktree", () => ({
        retiring: this.retireWorktreeOf(closed, { force: close.removeKept === true }),
      }));
      await retiring;
    }
    // Delivery machinery follows its parent out, whatever the direction
    // the parent closed in - a review must never outlive its builder.
    const { children } = step("close-children", () => ({
      children: this.retireDeliveryChildren(taskId, closed?.title),
    }));
    await children;
    // Any close may release a row waiting on this task, or leave one
    // waiting forever (the ready query and the dead-blocker card, P2).
    void step("close-gates", () => this.host.sweepGates(this.host.now()));
  }

  /**
   * A close takes the task's approvals out of this person's batch line
   * before its record closes: every one but the approval a merge is
   * spending, which leaves the line as its batch merges. Returns the record
   * as it reads after; a closed record is left as it is.
   */
  private leaveLine(
    taskId: string,
    record: TaskRecord | undefined,
    reason: ClosingReason,
  ): TaskRecord | undefined {
    if (!record || TaskService.isClosed(record)) return record;
    const approval = record.delivery?.mergeAuthorization;
    if (!approval) return record;
    if (reason !== "merged") this.approvals.removeQueueMark(taskId, approval);
    for (const item of approval.queued ?? []) this.approvals.removeQueueMark(taskId, item);
    return this.host.tasks.get(taskId) ?? record;
  }

  /**
   * A standing approval ends with its task, whichever way it closes: spent
   * by a merge, revoked by any other close (FI3-304), a cancelled or failed
   * turn's included. Approvals of its other pull requests waiting behind it
   * end too (INF-2746). Runs inside the close's own transaction.
   */
  private endApprovals(open: TaskRecord, reason: ClosingReason): void {
    const standing = standingAuthorization(open.delivery);
    const ended = open.delivery?.mergeAuthorization;
    if (standing) {
      this.host.tasks.delivery.recordPermissionRecords(open.id, {
        mergeAuthorization: {
          ...endedAuthorization(standing, {
            status: reason === "merged" ? "consumed" : "revoked",
            reason: `the task closed ${reason}`,
            endedAt: this.host.now(),
            generation: standing.generation + 1,
          }),
          queued: undefined,
        },
      });
    } else if (ended?.queued?.length) {
      this.host.tasks.delivery.recordPermissionRecords(open.id, {
        mergeAuthorization: { ...ended, queued: undefined },
      });
    }
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
    const live = this.host.tasks.graph
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
   * closes the record, ends its merge approvals as every close does
   * (`endApprovals`), retires its open cards, and saves/removes its worktree.
   * A cancel closes its open pull request where the project lives; a failure
   * never does, since the attempt's change is still the captain's to merge,
   * close or carry on in a fresh attempt. There is no `completed` here any more (WI-11): a crewmate that finished
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
    // A record closed with no crewmate running - its conversation let go
    // between turns - ends its build in the personal workspace here, or
    // later edits there keep naming a closed task (INF-3307 row 16).
    this.host.endLiveTask(taskId);
    const sentence = status === "cancelled" ? this.takeClosingSentence(taskId, actor) : undefined;
    this.leaveLine(taskId, record, status);
    this.closeAndPurge([taskId], () => {
      const open = this.host.tasks.get(taskId);
      if (open && !TaskService.isClosed(open)) this.endApprovals(open, status);
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
    if (status === "cancelled") void this.closeOpenPullRequest(taskId);
    this.host.cards.retireTaskCards(taskId, status);
    if (record && status === "cancelled") this.placeOutcome(record, "cancelled", actor, sentence);
    this.host.asksMoved?.();
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
    // A close's sweep of what the task left running goes first (docs/leftover-programs.md).
    await this.host.leftovers?.settled(taskId);
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
      this.host.tasks.placement.markWorkspaceRemoved(taskId);
      return "removed";
    }
    const retired = await this.host.workspace.retireTaskWorktree(
      workspace,
      options.keepAlways ? { keepAlways: true } : {},
    );
    if (retired.outcome === "kept") {
      if (options.force) {
        await this.host.workspace.removeTaskWorktree(workspace);
        this.host.tasks.placement.markWorkspaceRemoved(taskId);
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
    if (stillPresent()) this.host.tasks.placement.markWorkspaceRemoved(taskId);
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
  closeAndPurge<T>(taskIds: string[], close: () => T, stopping?: Promise<unknown>): T {
    for (const id of taskIds) this.host.killJobs?.(id);
    // An earlier version put a note up after a merge click (INF-1275,
    // retired by INF-2913). It carries no task, so the card retire leaves
    // it: one still up from that version ends with its task here.
    for (const id of taskIds)
      this.host.cards.hostCards.withdrawHostCard(mergePendingCardId(id), "task-closed");
    const closed = this.host.inbox.transaction(() => {
      for (const id of taskIds) this.host.inbox.purgeTask(id);
      return close();
    });
    // What each closed task left running stops once its crewmate has: begun
    // as the record closes, so its working copy's retirement and its
    // temporary folder's removal wait for it (docs/leftover-programs.md).
    for (const id of taskIds) this.host.leftovers?.begin(id, stopping);
    return closed;
  }
}
