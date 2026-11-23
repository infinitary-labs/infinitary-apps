import type { InboxStore } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import type { DependencyWait } from "../tasks/dependencyWaits";
import { TaskGraph } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import {
  baseApprovalEndedWake,
  baseClosedUnmergedOnce,
  baseClosedUnmergedWake,
  baseMovedWake,
  dependencyClosedOnce,
  dependencyClosedWake,
  mergeLineOnce,
  mergeLineWake,
  waitMovedOnce,
  waitMovedWake,
} from "./deliveryWakes";
import { candidateHead, waitingInLine } from "./mergeAuthorization";
import type { TypedWake } from "./wakes";

/** A typed wait a task stands on: how it was declared, and the work it names. */
export type TaskWait = DependencyWait & { kind: "baseline" | "blocks" };

/** What the steers need of the ladder's host. */
export type DependencySteersHost = {
  tasks: TaskService;
  inbox: InboxStore;
  steer(taskId: string, message: TypedWake): Promise<unknown>;
};

/**
 * The steers a task hears about the work under it: a wait that closed, the
 * part it was built on, a wait that moved to another task, and the quiet of
 * a kept merge approval in the batch line. Each goes once by its name, and
 * the ladder's sweep (`idleLadder.ts`) decides when to send them.
 */
export class DependencySteers {
  /**
   * The dependency waits whose end this process already tried to steer
   * about: a steer that could not go (no conversation to resume) records
   * no once-name, so this keeps the sweep from retrying it every tick.
   */
  private readonly resumesTried = new Set<string>();

  constructor(
    private readonly host: DependencySteersHost,
    private readonly liveWaits: (record: TaskRecord) => TaskWait[],
  ) {}

  /**
   * Work a task waited on closed (FI3-250): the task hears it as one steer
   * on its own lane, named by that work so the inbox queues it once, even
   * across a restart. Like a timed wait's end it opens a new idle episode,
   * so the turn it starts is the task's own, not a ladder turn.
   */
  endDependencyWait(taskId: string, ended: TaskWait): void {
    const once = dependencyClosedOnce(ended.task);
    const tried = `${taskId}\n${once}`;
    if (this.resumesTried.has(tried) || this.host.inbox.woken(taskId, once)) return;
    this.resumesTried.add(tried);
    this.host.tasks.turns.endIdle(taskId);
    const pullRequest = ended.task.delivery?.prNumber;
    const carried =
      ended.kind === "blocks"
        ? this.movedFrom(taskId, ended.task.id).map((task) => task.key || task.id)
        : [];
    void this.host
      .steer(
        taskId,
        dependencyClosedWake(
          { ...ended.task, ...(pullRequest ? { pullRequest } : {}) },
          ended.kind,
          carried,
          ended.task.shape?.program !== undefined &&
            this.host.tasks.crewFilingOrigin(ended.task.id)?.id === taskId,
        ),
      )
      .catch((caught: unknown) => {
        // No conversation to resume: the ladder reads the task on its own clock.
        console.warn("[crew] a closed dependency's steer not delivered:", caught);
      });
  }

  /**
   * A part that started on an earlier part's approved version (`built_on`)
   * follows that part (docs/task-graph.md, "A part that starts at approval"
   * and "Following the part under it"), hearing once for each fact: the
   * part's approval ended while it is live, so its own merge waits; the
   * part is approved at a newer version than the recorded base, so it
   * replays its own commits onto that version; or the part closed without
   * merging, so it reports to the first mate. Each steer is named so the
   * inbox queues it once, even across a restart. Returns the earlier part
   * when its close was told here, so its wait's own close steer is not sent.
   */
  followBase(record: TaskRecord): string | undefined {
    const builtOn = this.host.tasks.graph.unmergedBuiltOn(record);
    if (!builtOn) return undefined;
    const base = builtOn.task;
    if (TaskService.isClosed(base)) {
      const ended = base.delivery?.mergeAuthorization;
      this.steerOnce(
        record.id,
        baseClosedUnmergedWake({
          ...base,
          head: builtOn.head,
          ...(ended ? { newest: TaskGraph.newestApproved(ended) } : {}),
          closed: base.status === "done" ? "done" : "dropped",
        }),
      );
      return base.id;
    }
    const approval = base.delivery?.mergeAuthorization;
    if (!approval || !TaskGraph.approvedToMerge(base)) {
      this.steerOnce(record.id, baseApprovalEndedWake({ ...base, head: builtOn.head, approval }));
      return undefined;
    }
    // The newest version the earlier part's approval covers: a kept approval's repair moves it.
    const newest = candidateHead(approval);
    if (newest !== builtOn.head)
      this.steerOnce(
        record.id,
        baseMovedWake({
          ...base,
          branch: approval.target.branch,
          from: builtOn.head,
          to: newest,
        }),
      );
    return undefined;
  }

  /** One of `followBase`'s steers, sent once by its name. */
  private steerOnce(taskId: string, wake: TypedWake): void {
    const once = wake.once ?? "";
    const tried = `${taskId}\n${once}`;
    if (this.resumesTried.has(tried) || this.host.inbox.woken(taskId, once)) return;
    this.resumesTried.add(tried);
    this.host.tasks.turns.endIdle(taskId);
    void this.host.steer(taskId, wake).catch((caught: unknown) => {
      // No conversation to resume: the ladder reads the task on its own clock.
      console.warn("[crew] a steer about the part under a task not delivered:", caught);
    });
  }

  /**
   * The tasks whose wait the task's timeline records moving to `carrierId`:
   * when a replaced-by link was written (INF-1826, `TaskGraph.moveWaits`), or
   * when a merge's after-merge step held it for the rest of the work
   * (INF-3846 piece 4, `TaskGraph.carryWait`).
   */
  private movedFrom(taskId: string, carrierId: string): TaskRecord[] {
    const tasks = this.host.tasks;
    const ids = new Set(
      tasks
        .timeline(taskId)
        .filter((event) => event.kind === "unlinked" && event.data?.movedTo === carrierId)
        .map((event) => event.data?.fromId)
        .filter((id): id is string => typeof id === "string"),
    );
    return [...ids].flatMap((id) => [tasks.get(id)].filter((row): row is TaskRecord => !!row));
  }

  /**
   * The live waits that moved to another task after the waiter was told the
   * old one was dropped (INF-1826): a late replaced-by link. Each names the
   * dropped task and the one carrying its work now.
   */
  movedWaits(record: TaskRecord): { replaced: TaskRecord; carrier: TaskRecord }[] {
    const tasks = this.host.tasks;
    return this.liveWaits(record).flatMap(({ task, kind }) => {
      if (kind !== "blocks") return [];
      const told = tasks.graph.replacedPredecessors(task.id).filter(
        (old) =>
          old.status === "dropped" &&
          // A part built on the dropped task heard of its close in its own steer.
          (this.host.inbox.woken(record.id, dependencyClosedOnce(old)) ||
            this.host.inbox.woken(record.id, baseClosedUnmergedOnce(old))) &&
          !this.host.inbox.woken(record.id, waitMovedOnce(old, task)),
      );
      if (told.length === 0) return [];
      const moved = new Set(this.movedFrom(record.id, task.id).map((old) => old.id));
      return told
        .filter((old) => moved.has(old.id))
        .map((replaced) => ({ replaced, carrier: task }));
    });
  }

  /**
   * The captain's kept merge approval waits in the batch line or the
   * host's merge queue (INF-4497 finding 2), and its crewmate has been idle
   * as long as the ladder's nudge waits: it hears once, named
   * by the approval and its line so the inbox queues it once even across a
   * restart, that the quiet is the line's and nothing is needed from it.
   */
  tellMergeLine(record: TaskRecord): void {
    const waiting = waitingInLine(record.delivery);
    if (!waiting) return;
    const once = mergeLineOnce(waiting.approval, waiting.line);
    const tried = `${record.id}\n${once}`;
    if (this.resumesTried.has(tried) || this.host.inbox.woken(record.id, once)) return;
    this.resumesTried.add(tried);
    this.host.tasks.turns.endIdle(record.id);
    void this.host
      .steer(
        record.id,
        mergeLineWake(waiting.approval, waiting.line, candidateHead(waiting.approval)),
      )
      .catch((caught: unknown) => {
        // No conversation to resume: the line still holds the ladder quiet.
        console.warn("[crew] a kept merge's line steer not delivered:", caught);
      });
  }

  /** One steer naming the task that carries the work a dropped wait was on (INF-1826). */
  tellMovedWait(taskId: string, moved: { replaced: TaskRecord; carrier: TaskRecord }): void {
    const once = waitMovedOnce(moved.replaced, moved.carrier);
    const tried = `${taskId}\n${once}`;
    if (this.resumesTried.has(tried)) return;
    this.resumesTried.add(tried);
    this.host.tasks.turns.endIdle(taskId);
    void this.host
      .steer(taskId, waitMovedWake(moved.replaced, moved.carrier))
      .catch((caught: unknown) => {
        // No conversation to resume: the ladder reads the task on its own clock.
        console.warn("[crew] a moved wait's steer not delivered:", caught);
      });
  }
}
