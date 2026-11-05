import type { Card } from "@shared/cards";
import { overridePasses, softHoldWords } from "@shared/holds";
import { isFolderWork } from "@shared/routingPolicy";
import type { TaskRecord } from "../storage/taskStore";
import { carriedOnClose, type SettleRefusal, TaskService } from "../tasks/taskService";
import { taskResultResponse } from "./answerTaskResponse";
import { cardEmitter } from "./cardEmit";
import type { SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import { describeStatus, type SettleService } from "./settleService";
import { changeName } from "./settleWords";
import { type TaskClosing, workspaceOf } from "./taskClose";
import type { AnswerTaskClosedPayload } from "./wakes";

/** Whether two tasks deliver through the same pull request or pushed branch. */
function sameChange(left: TaskRecord, right: TaskRecord): boolean {
  const a = left.delivery;
  const b = right.delivery;
  if (a?.prUrl && b?.prUrl) return a.prUrl === b.prUrl;
  return (
    left.repoId !== null &&
    left.repoId === right.repoId &&
    a?.prNumber !== undefined &&
    a.prNumber === b?.prNumber
  );
}

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

/**
 * Closes the first mate or the host declares on a typed fact rather than a
 * settle: an answer the captain chose or handed on, work carried on by
 * another task, finished folder work, and a release that already shipped
 * the change.
 */
export class DeclaredCloses {
  constructor(
    private readonly host: SettleServiceHost,
    private readonly locks: SettleLocks,
    private readonly closing: TaskClosing,
    private readonly settle: SettleService,
  ) {}

  /**
   * The answer task's own close (Task B, captain F2 A). The captain's choice
   * on the card its own crewmate emitted closes it `done/answered`: the
   * deliverable was produced and he answered it, which is not the same as
   * declining a decision the Firstmate raised. The close control never
   * chooses or ends work. Only an ordinary note read or duplicate closure
   * notifies its live author; only the ordinary read acknowledges a note.
   * After that acknowledgement, the crewmate can report `finished` and the
   * Firstmate can settle the answer task `answered`. A marked saved answer
   * instead waits for explicit Done (`answer-done`), which receipts it and
   * closes the answer task `done/answered` without a `card-closed` steer.
   * Interrupt, cancel and `update_task drop` keep their own closes.
   */
  closeAnsweredTask(card: Card, action: string, by: "captain" | "firstmate" | "crewmate"): boolean {
    const record = card.taskId ? this.host.tasks.get(card.taskId) : undefined;
    if (!taskResultResponse(card, record, action, by) || !record || !card.taskId) return false;
    const choice = card.actions.find((entry) => entry.id === action);
    // A plain result choice is a receipt, never consent or a merge effect.
    // Change tasks still wait for an explicit answered settle and a clean-work check.
    if (choice && !choice.effect)
      this.host.tasks.recordResultHandoff(record.id, { cardId: card.id, action });
    if (this.host.deliverableOf(record) !== "answer") return false;
    const text = !choice ? "marked answer Done" : `chose "${choice.label}"`;
    // An invalid action never produces a closure-choice wake.
    const handoff = choice ? this.answerTaskClosedPayload(record, card, choice) : undefined;
    void this.closing
      .closeTask(card.taskId, {
        status: "done",
        reason: "answered",
        actor: "captain",
        text,
        ...(handoff ? { answerHandoff: handoff } : {}),
      })
      .catch(() => {});
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

  /**
   * settle_task carried_on (INF-1825): started work another task carries on
   * closes done through it. The replaced-by link is written first, so the
   * waits on this task move to that one (`TaskService.moveWaits`) before
   * the close clears them; its unmerged commits are saved as every close
   * saves them, and its own pull request is closed unless the other task
   * carries that same pull request. No closing note goes up: the close's
   * reason gives none (`closedWithoutClick`).
   */
  async closeCarriedOn(
    taskRef: string,
    carrierRef: string,
  ): Promise<{ ok: boolean; text: string }> {
    const record = this.host.resolveTaskRef(taskRef, "task_id");
    const carrier = this.host.resolveTaskRef(carrierRef, "carried_by");
    const handle = `${record.key || record.id} "${record.title}"`;
    const other = carrier.key || carrier.id;
    const refuse = (why: string) => ({
      ok: false,
      text: `Cannot close ${handle} as carried on by ${other}: ${why}`,
    });
    if (TaskService.isClosed(record)) return refuse(`it is already ${describeStatus(record)}.`);
    const refusal = this.host.tasks.carrierRefusal(record.id, carrier.id);
    if (refusal) return { ok: false, text: refusal };
    const card = this.host.cards
      .snapshot()
      .find((entry) => entry.taskId === record.id && entry.actions.length > 0);
    if (card)
      return refuse(
        `its card "${card.title}" still waits on the captain, and their choice there comes first.`,
      );
    const gate = this.host.tasks.closeRefusal(record.id);
    if (gate) return refuse(gate.text);
    const pending = this.locks.settlingTasks.get(record.id);
    if (pending) return refuse(`${pending} is already in progress. Wait for its outcome.`);
    this.locks.settlingTasks.set(record.id, "carried_on");
    let pullRequest = "";
    try {
      this.host.tasks.link(record.id, carrier.id, "replaced-by", "firstmate");
      const end = this.host.tasks.carrierOf(record.id);
      const shared = [carrier, end].some((next) => next && sameChange(record, next));
      if (!shared) pullRequest = (await this.closing.closeOpenPullRequest(record.id)).text;
      await this.closing.closeTask(record.id, carriedOnClose(carrier, "firstmate"));
    } finally {
      this.locks.settlingTasks.delete(record.id);
    }
    this.placeHeldOutcome(record.id);
    return {
      ok: true,
      text: `Closed ${handle} as done: ${other} carries on its work.${pullRequest ? ` ${pullRequest}` : ""}`,
    };
  }

  /**
   * The outcome of a carrier that closed before the work it carries on
   * (INF-1825): the old task's message held it back while that task was
   * open, and the old task's close puts up nothing of its own, so the
   * carrier's outcome is placed once, where it would have gone.
   */
  private placeHeldOutcome(oldId: string): void {
    const carrier = this.host.tasks.carrierOf(oldId);
    if (!carrier || carrier.id === oldId || !TaskService.isClosed(carrier)) return;
    if (!carrier.closedReason) return;
    const chain = this.host.askEnding.chainsOf(carrier.id)[0];
    if (!chain?.work.some((task) => task.id === oldId)) return;
    const close = this.host.tasks
      .timeline(carrier.id)
      .findLast(
        (event) =>
          event.data?.status === carrier.status && event.data?.reason === carrier.closedReason,
      );
    if (!close) return;
    const sentence =
      typeof close.data?.closingSentence === "string" ? close.data.closingSentence : undefined;
    const actor = close.actor === "captain" || close.actor === "firstmate" ? close.actor : "host";
    this.closing.placeOutcome(carrier, carrier.closedReason, actor, sentence);
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
        "it was not opened as an internal step of yours - the captain asked for this answer, so it closes on their choice or Done on its marked note, or once its crewmate reports it finished after their explicit acknowledgement. Putting the card away is not that acknowledgement.",
      );
    }
    if (record.status !== "active" || this.locks.working(record.id)) {
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
          this.locks.working(record.id) ||
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
      await this.closing.closeTask(record.id, {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text: "answered - its reported result was handed on",
        data: { handedOn: true },
      });
      return { ok: true, text: `Closed ${handle} as answered: its reported result was handed on.` };
    }
    if (!carriedBy && finished) {
      await this.closing.closeTask(record.id, {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text: "answered - the captain read it and its crewmate finished",
      });
      return { ok: true, text: `Closed ${handle} as answered: the captain has read it.` };
    }
    if (!carriedBy) {
      await this.closing.closeTask(record.id, {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text: "answered - its crewmate reported the answer",
        data: { reported: true },
      });
      return { ok: true, text: `Closed ${handle} as answered: its crewmate reported the answer.` };
    }
    const successor = `${carriedBy.key || carriedBy.id} "${carriedBy.title}"`;
    await this.closing.closeTask(record.id, {
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
   * success, including legacy folder work and a personal workspace build
   * (INF-1677). Evidence is its judgment, not
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
    if (this.locks.settlingTasks.has(record.id) || record.pendingSettle)
      return refuse("another settle is already in progress.");
    // The personal workspace builds in place too (INF-1677): the host
    // commits each turn, so its finished work closes here like folder work.
    const personal = this.host.isPersonalTask(record.id);
    if (
      record.kind !== "work" ||
      !(
        this.host.deliverableOf(record) === "operation" ||
        (this.host.deliverableOf(record) === "change" &&
          (personal || isFolderWork(record.shape?.in_place)))
      )
    )
      return refuse(
        "this mode is for an operation or work built in place, not an answer or a change to merge.",
      );
    if (
      this.host.deliverableOf(record) !== "operation" &&
      (record.worktreeDir || record.branch || record.deviceId)
    )
      return refuse(
        "this task has a working copy or branch of its own; use its delivery path instead.",
      );
    if (record.status !== "active" || record.activity !== "idle" || this.locks.working(record.id))
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
    this.locks.settlingTasks.set(record.id, "finished");
    try {
      // All reads above are synchronous. Commit before stopping can yield,
      // so newly arriving guidance sees a closed task rather than being lost.
      await this.closing.closeTask(
        record.id,
        {
          status: "done",
          reason: "finished",
          actor: "firstmate",
          text: `finished: ${evidence}`,
          data: { completionEvidence: evidence },
          ...(personal ? { delivery: { mode: "in-place" as const } } : {}),
        },
        { recordBeforeStop: true },
      );
      return { text: `Closed ${handle} as finished: ${evidence}` };
    } finally {
      this.locks.settlingTasks.delete(record.id);
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
    if (this.locks.settlingTasks.has(record.id) || record.pendingSettle)
      return refuse("another settle is already in progress.");
    if (record.kind !== "work" || this.host.deliverableOf(record) !== "change")
      return refuse("this is not a work task delivering a change.");
    if (this.host.isPersonalTask(record.id))
      return refuse("the personal workspace builds in place and closes from its report.");
    if (record.status !== "active" || record.activity !== "idle" || this.locks.working(record.id))
      return refuse("wait for its crewmate to finish and report first.");
    if (!record.outcome) return refuse("its crewmate has not reported the result yet.");
    const evidence = releaseEvidence.trim();
    if (!evidence)
      return refuse("name the release and the evidence that its delivery was verified.");
    // A pull request of its own does not stop a release close: one closed
    // without merging, its work delivered by another merged pull request or
    // a release, is the case this close is for. Only one that may still be
    // open does - it reads open, or cannot be read (INF-2628).
    if (
      this.settle.pullNumbersOf(record).size === 0 &&
      (record.delivery?.prUrl || record.delivery?.changeLabel)
    )
      return refuse(
        "its pull request could not be read, so it may still be open; check it where the project lives before closing the task.",
      );
    if ((!record.deviceId && !record.worktreeDir) || record.workspaceState !== "present")
      return refuse("its working copy is unavailable; check the work before closing it.");
    const gate =
      this.host.tasks.closeRefusal(record.id) ?? this.host.tasks.blockerRefusal(record.id);
    if (gate) return { text: gate.text, refusal: gate };
    this.locks.settlingTasks.set(record.id, "external release");
    try {
      const pulls = [...this.settle.pullNumbersOf(record)].sort((a, b) => a - b);
      const open = await this.settle.openChangeAmong(record);
      if (open)
        return refuse(
          open.unread
            ? `${changeName(record, open.number)} could not be read, so it may still be open; close or merge it first, or try again once it reads.`
            : `${changeName(record, open.number)} is still open; close or merge it first.`,
        );
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
      // Commits that history alone calls unmerged - a squash merge's
      // originals, or a closed pull request's - do not refuse: the close
      // saves them on the task's kept ref before the working copy goes.
      // Uncommitted edits are no delivered work, so they still refuse.
      if (work.dirty)
        return refuse(
          "its working copy has uncommitted edits. Commit them or resolve them before closing it.",
        );
      // Recheck after the asynchronous work read: a concurrent turn may have
      // started or a card may have placed a new gate in the meantime.
      const current = this.host.tasks.get(record.id);
      if (
        this.locks.working(record.id) ||
        current?.status !== "active" ||
        current.activity !== "idle" ||
        current.pendingSettle ||
        current.deviceId !== record.deviceId ||
        current.worktreeDir !== record.worktreeDir ||
        current.workspaceState !== "present" ||
        [...this.settle.pullNumbersOf(current)].sort((a, b) => a - b).join() !== pulls.join() ||
        (pulls.length === 0 && (current.delivery?.prUrl || current.delivery?.changeLabel))
      )
        return refuse("its state changed while the working copy was checked; try again.");
      const newGate =
        this.host.tasks.closeRefusal(record.id) ?? this.host.tasks.blockerRefusal(record.id);
      if (newGate) return { text: newGate.text, refusal: newGate };
      await this.closing.closeTask(record.id, {
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
      this.locks.settlingTasks.delete(record.id);
    }
  }
}
