import type { PendingSettleIntent } from "../storage/taskStore";
import type { SettleServiceHost } from "./settleHost";

/**
 * Who holds a task's settle right now (docs/task-record.md): one settle at
 * a time across cards, the shell and the Firstmate's tools, the merges whose
 * request went out past the last look, and a merge or land the captain asked
 * for mid-turn waiting as a durable intent for the turn's boundary.
 */
export class SettleLocks {
  constructor(private readonly host: Pick<SettleServiceHost, "runtimeState" | "tasks">) {}

  /** Per-task exclusion, shared by card actions and conversational settles. */
  readonly settlingTasks = new Map<string, string>();

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
