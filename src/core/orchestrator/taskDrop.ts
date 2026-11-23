import type { DropTaskReview } from "@shared/cards";
import { TASK_CARD_VIA } from "@shared/provenance";
import {
  DROP_REVIEW_STALE,
  dropMissingRefusal,
  dropReviewKeys,
  NO_LONGER_WANTED,
  sameDropReview,
} from "@shared/recordDrop";
import type { TaskRecord } from "../storage/taskRecords";
import type { SettleOutcome, SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import { closeGateRefusal, unlandedWorkRefusal, unreadableWorkRefusal } from "./settleRefusals";
import { describeStatus } from "./settleService";
import { decisionDropRefusal, discardedText } from "./settleWords";
import { type TaskClosing, workspaceOf } from "./taskClose";

export type DropInput = {
  /**
   * The captain's own drop (a Drop task, a click on a Discard button)
   * passes every hold; the first mate dropping on its own meets them.
   */
  actor: "captain" | "firstmate";
  /** The surface's word, which the record reads: Discard as discarded, Drop task as cancelled. */
  reason: "discarded" | "cancelled";
  /** The first mate's drop after the captain chose it: passes the work holds. */
  confirm?: boolean;
  /** The first mate's drop keeping its open parts planned, after the captain chose. */
  proceedWithOpen?: boolean;
  /** What the captain's record showed the captain about never-started work, checked again here. */
  review?: DropTaskReview;
  via?: typeof TASK_CARD_VIA | "shell";
  /** The panel the captain dropped it from, by its title. */
  panel?: string;
};

/** A drop the record refused at once, before anything was stopped. */
type Refused = SettleOutcome & { ok: false };

function neverStarted(record: TaskRecord): boolean {
  return (
    record.status === "open" &&
    record.startedAt == null &&
    !record.worktreeDir &&
    record.workspaceState !== "present"
  );
}

/**
 * One drop (INF-3169's plan, piece 4; the captain's pick "Also fold the
 * three into one drop"; docs/task-record.md, "One drop"). The first mate's
 * and the merge card's Discard and the captain's Drop task, on started and
 * on never-started work, all end a task here, by one set of rules.
 *
 * It refuses outright only the real limits: a task that is not here, a
 * decision, another settle of the same task still running, a task already
 * closed with neither a kept copy left nor a failure's pull request, and a
 * record that changed since the captain reviewed it. A drop stops a working
 * crewmate, closes the task's own open pull request and waits for that close
 * (filing the task that closes it when the host refuses), and saves its
 * commits and edits as every close saves them. A copy whose work cannot be
 * saved stays on disk and the record says so; dropping the closed task again
 * removes it. A failure leaves its pull request open, and discarding the
 * failed task closes it, unless an open task, such as its retry, now
 * delivers through it. Open parts stay planned and a started part keeps
 * working.
 *
 * The captain's own drop passes every hold. The first mate dropping on its
 * own meets the open parts (`proceed_with_open` or the captain's recorded override
 * passes them), a crewmate still working, and work that is not merged or
 * cannot be read (`confirm`, after the captain chose, passes those).
 */
export class TaskDrop {
  constructor(
    private readonly host: SettleServiceHost,
    private readonly locks: SettleLocks,
    private readonly closing: TaskClosing,
  ) {}

  /**
   * The drop's refusals that need no reading: answered at once, so the
   * captain's click on the record hears it in the same breath.
   */
  refusal(taskId: string, input: DropInput): Refused | undefined {
    const record = this.host.tasks.get(taskId);
    if (!record) return { ok: false, text: dropMissingRefusal(taskId) };
    if (record.kind === "decision")
      return { ok: false, text: decisionDropRefusal(record.key || taskId) };
    const pending = this.locks.holder(taskId);
    if (pending)
      return {
        ok: false,
        contention: true,
        text: `Cannot drop task ${taskId}: ${pending} is already in progress. Wait for its outcome.`,
      };
    const closed = record.status === "done" || record.status === "dropped";
    if (closed && !keptCopy(record) && !failedWithPullRequest(record))
      return {
        ok: false,
        text: `Task ${taskId} "${record.title}" is already ${describeStatus(record)}; there is nothing to discard.`,
      };
    if (
      input.review &&
      !sameDropReview(dropReviewKeys(this.host.tasks.dropEffects(taskId)), input.review)
    )
      return { ok: false, text: DROP_REVIEW_STALE };
    if (closed || input.actor === "captain") return undefined;
    // The first mate alone meets the open parts, which the captain's own drop keeps planned.
    const parts = closeGateRefusal(this.host, taskId, "discard", input.proceedWithOpen ?? false);
    if (parts) return { ok: false, text: parts.text, refusal: parts };
    if (this.locks.working(taskId) && !input.confirm)
      return {
        ok: false,
        text: `Cannot discard task ${taskId} "${record.title}" while it is still working. Interrupt it first, or pass confirm true after the captain chooses.`,
      };
    return undefined;
  }

  async drop(taskId: string, input: DropInput): Promise<SettleOutcome> {
    const refused = this.refusal(taskId, input);
    if (refused) return refused;
    const record = this.host.tasks.get(taskId) as TaskRecord;
    const closed = record.status === "done" || record.status === "dropped";
    if (!closed && neverStarted(record) && this.host.runtimeState(taskId) === undefined)
      return this.dropNeverStarted(record, input);
    const lease = this.locks.claim(taskId, "a drop");
    try {
      if (input.actor === "firstmate" && !input.confirm) {
        // On a computer that runs work, that computer reads its own working
        // copy; while it is out of reach nobody can say it holds nothing.
        const work = record.deviceId
          ? await (this.host.placed?.workStatus(taskId) ?? Promise.resolve(null))
          : await this.host.workspace.taskWorkStatus(workspaceOf(record));
        if (!work && record.workspaceState === "present") {
          const refusal = unreadableWorkRefusal(record);
          return { ok: false, text: refusal.text, refusal };
        }
        if (work && (work.dirty || work.unlandedCommits > 0)) {
          const refusal = unlandedWorkRefusal(this.host, record, work);
          return { ok: false, text: refusal.text, refusal };
        }
      }
      // A closed task's kept copy, whose work could not be saved when it
      // closed: dropping it again is the choice to remove it. A failure
      // leaves its pull request open for a retry to build on; discarding the
      // failed task is the choice to close it.
      if (closed) {
        const carrier = failedWithPullRequest(record) ? this.carrierOf(record) : undefined;
        const pull = carrier
          ? // i18n-exempt: the discard's answer to the first mate, not shown to a person
            {
              text: `Its PR #${record.delivery?.prNumber} stays open: ${carrier} delivers through it now.`,
            }
          : failedWithPullRequest(record)
            ? await this.closing.closeOpenPullRequest(taskId, { line: input.actor === "firstmate" })
            : undefined;
        if (keptCopy(record))
          await this.closing.closeTask(taskId, {
            status: "dropped",
            reason: input.reason,
            actor: input.actor,
            removeKept: true,
          });
        return {
          ok: true,
          text: discardedText(pull?.text),
          ...(pull && "problem" in pull && pull.problem ? { problem: pull.problem } : {}),
          ...(pull && "repair" in pull && pull.repair ? { followup: pull.repair } : {}),
        };
      }
      const pull = await this.closing.closeOpenPullRequest(taskId, {
        line: input.actor === "firstmate",
      });
      await this.closing.closeTask(taskId, {
        status: "dropped",
        reason: input.reason,
        actor: input.actor,
        ...(input.via || input.panel ? { data: this.provenance(input) } : {}),
      });
      return {
        ok: true,
        text: discardedText(pull.text),
        ...(pull.problem ? { problem: pull.problem } : {}),
        ...(pull.repair ? { followup: pull.repair } : {}),
      };
    } finally {
      lease.release();
    }
  }

  /**
   * Never-started work has no crewmate, copy or pull request: its record
   * closes in this call, before anything yields, so a start the sweep was
   * about to make finds it closed. The captain's drop from the record is
   * written with its review checked in the write's own transaction, and
   * keeps the fact that it closed before it started, which Activity reads.
   */
  private async dropNeverStarted(record: TaskRecord, input: DropInput): Promise<SettleOutcome> {
    if (input.actor === "captain" && input.review) {
      const { review } = input;
      const written = this.closing.closeAndPurge([record.id], () =>
        this.host.tasks.starts.dropUnstarted(record.id, {
          actor: "captain",
          review,
          reason: NO_LONGER_WANTED,
          ...(input.via === TASK_CARD_VIA ? { via: TASK_CARD_VIA } : {}),
          ...(input.panel ? { panel: input.panel } : {}),
        }),
      );
      if (!written.ok) return { ok: false, text: written.text };
      this.host.cards.retireTaskCards(record.id, "obsolete");
      this.host.asksMoved?.();
      void this.host.sweepGates(this.host.now());
      return { ok: true, text: discardedText() };
    }
    await this.closing.closeTask(record.id, {
      status: "dropped",
      reason: input.reason,
      actor: input.actor,
      ...(input.via || input.panel ? { data: this.provenance(input) } : {}),
    });
    return { ok: true, text: discardedText() };
  }

  /**
   * The open task that took over a failed task's pull request - a retry that
   * built on it, as its brief lets it - named by its key, so discarding the
   * failed task never closes the pull request that task delivers through.
   */
  private carrierOf(record: TaskRecord): string | undefined {
    const number = record.delivery?.prNumber;
    const carrier = this.host.tasks
      .listLive()
      .find(
        (live) =>
          live.id !== record.id &&
          live.repoId === record.repoId &&
          live.delivery?.prNumber === number,
      );
    return carrier ? carrier.key || carrier.id : undefined;
  }

  private provenance(input: DropInput): Record<string, unknown> {
    return {
      ...(input.via ? { via: input.via } : {}),
      ...(input.panel ? { panel: input.panel } : {}),
    };
  }
}

/** A closed task whose work could not be saved when it closed keeps its copy on disk. */
function keptCopy(record: TaskRecord): boolean {
  return !!record.worktreeDir && record.workspaceState === "present";
}

/** A failed task's pull request stays open after the failure, for a retry or a discard to settle. */
function failedWithPullRequest(record: TaskRecord): boolean {
  return (
    record.status === "dropped" &&
    record.closedReason === "failed" &&
    record.delivery?.prNumber !== undefined
  );
}
