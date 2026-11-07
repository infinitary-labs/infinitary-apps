import type { PendingSettleIntent } from "../storage/taskStore";
import type { SettleServiceHost } from "./settleHost";

/**
 * Who holds a task's settle right now (docs/task-record.md): one settle at
 * a time across cards, the shell and the Firstmate's tools, the merges whose
 * request went out past the last look, and a merge or land the captain asked
 * for mid-turn waiting as a durable intent for the turn's boundary.
 */
export class SettleLocks {
  constructor(private readonly host: Pick<SettleServiceHost, "runtimeState" | "tasks" | "cards">) {}

  /**
   * Per-task exclusion, shared by card actions and conversational settles.
   * A settle's end redraws its task's cards: a story note held for its
   * merge shows after the settle's last write (INF-2678).
   */
  readonly settlingTasks = new SettlingTasks((taskId) => {
    this.host.cards.releaseMerged([taskId]);
    if (this.afterRelease.delete(taskId)) this.runAfterRelease(taskId);
  });

  /**
   * The tasks whose kept merge approval met another settle holding the
   * task, or waits behind one that settle ends (INF-2746): it runs once as
   * soon as that settle ends, not at the next minute's look.
   */
  private readonly afterRelease = new Set<string>();

  /** What runs a task's kept merge approval; set by the settle owners. */
  runKept: (taskId: string) => void = () => {};

  /** Run the task's kept merge approval once the settle holding it ends. */
  retryWhenFree(taskId: string): void {
    if (this.settlingTasks.has(taskId)) this.afterRelease.add(taskId);
    else this.runAfterRelease(taskId);
  }

  /** After the releasing settle's own last synchronous write. */
  private runAfterRelease(taskId: string): void {
    queueMicrotask(() => this.runKept(taskId));
  }

  /** Durable settle intents waiting for the current crewmate turn to go idle. */
  private readonly settleBoundaryWaiters = new Map<string, Set<() => void>>();

  /** Tasks whose merge request went out past the last look before it (`mergeBoundary`). */
  readonly sentMerges = new Set<string>();

  mergeWasSent(taskId: string): boolean {
    return this.sentMerges.has(taskId);
  }

  /** Whether the task's crewmate is mid-turn. */
  working(taskId: string): boolean {
    const state = this.host.runtimeState(taskId);
    return state !== undefined && state !== "idle";
  }

  /** Capture a merge/land intent and wait until the current turn is safely idle. */
  waitForSettleBoundary(taskId: string, intent: PendingSettleIntent): Promise<void> {
    if (!this.working(taskId)) return Promise.resolve();
    this.host.tasks.delivery.setPendingSettle(taskId, intent);
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
}

/** The tasks being settled, by what settles them; each end calls `ended`. */
class SettlingTasks extends Map<string, string> {
  constructor(private readonly ended: (taskId: string) => void) {
    super();
  }

  override delete(taskId: string): boolean {
    const had = super.delete(taskId);
    if (had) this.ended(taskId);
    return had;
  }
}
