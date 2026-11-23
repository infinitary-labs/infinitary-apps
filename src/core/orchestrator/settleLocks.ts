import type { PendingSettleIntent } from "../storage/taskRecords";
import type { SettleServiceHost } from "./settleHost";

type LocksHost = Pick<SettleServiceHost, "runtimeState" | "tasks" | "cards">;

export type TurnEndWait = { ended: true } | { ended: false; cancelled: string };

/**
 * Who holds a task's settle right now (docs/task-record.md): one settle at
 * a time across cards, the shell and the Firstmate's tools. Each is one
 * `SettleLease`, claimed with no await after reading that nothing holds it,
 * and released in its `finally`; every way the settle stands is a phase of
 * that lease, so its one release ends them all.
 */
export class SettleLocks {
  constructor(private readonly host: LocksHost) {}

  private readonly leases = new Map<string, SettleLease>();

  /** What runs a task's kept merge approval; set by the settle owners. */
  runKept: (taskId: string) => void = () => {};

  holder(taskId: string): string | undefined {
    return this.leases.get(taskId)?.label;
  }

  /** Take the task's one settle; the caller has read that nothing holds it. */
  claim(taskId: string, label: string): SettleLease {
    if (this.leases.has(taskId)) throw new Error(`Task ${taskId} is already being settled.`);
    const lease = new SettleLease(taskId, label, this.host, () => {
      if (this.leases.get(taskId) !== lease) return;
      this.leases.delete(taskId);
      // A settle's end redraws its task's cards: a story note held for its
      // merge shows after the settle's last write (INF-2678).
      this.host.cards.releaseMerged([taskId]);
      if (lease.retryKept) this.runAfterRelease(taskId);
    });
    this.leases.set(taskId, lease);
    return lease;
  }

  /**
   * Run the task's kept merge approval once the settle holding it ends
   * (INF-2746): at once when nothing holds it, never at the next minute's look.
   */
  retryWhenFree(taskId: string): void {
    const lease = this.leases.get(taskId);
    if (lease) lease.retryKept = true;
    else this.runAfterRelease(taskId);
  }

  /** After the releasing settle's own last synchronous write. */
  private runAfterRelease(taskId: string): void {
    queueMicrotask(() => this.runKept(taskId));
  }

  /** Whether the task's merge request went out past the last look before it (`mergeBoundary`). */
  mergeWasSent(taskId: string): boolean {
    return this.leases.get(taskId)?.phase === "sent";
  }

  /** Whether the task's crewmate is mid-turn. */
  working(taskId: string): boolean {
    return working(this.host, taskId);
  }

  /**
   * The crewmate's turn ended, or its session did: a settle waiting for
   * that goes on. Says whether one waited, since it then owns this idle boundary.
   */
  turnEnded(taskId: string): boolean {
    return this.leases.get(taskId)?.wake({ ended: true }) ?? false;
  }

  /**
   * End a settle's wait for the turn's end without running it; `why` is in
   * plain words, since the captain's Activity line reads it.
   */
  cancelWait(taskId: string, why: string): void {
    this.leases.get(taskId)?.wake({ ended: false, cancelled: why });
  }
}

export class SettleLease {
  /** `waiting` for the turn's end, `sent` once its merge request went out. */
  phase: "claimed" | "waiting" | "sent" = "claimed";
  /** A kept merge approval to run once this settle ends. */
  retryKept = false;
  private waiter?: (outcome: TurnEndWait) => void;

  constructor(
    private readonly taskId: string,
    readonly label: string,
    private readonly host: LocksHost,
    readonly release: () => void,
  ) {}

  /**
   * Capture a merge or land intent durably and wait until the current turn
   * is safely idle; a crewmate already idle answers at once.
   */
  waitForTurnEnd(intent: PendingSettleIntent): Promise<TurnEndWait> {
    if (!working(this.host, this.taskId)) return Promise.resolve({ ended: true });
    this.host.tasks.delivery.setPendingSettle(this.taskId, intent);
    this.phase = "waiting";
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Answer the wait; says whether one was waiting. */
  wake(outcome: TurnEndWait): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = undefined;
    this.phase = "claimed";
    waiter(outcome);
    return true;
  }

  sent(): void {
    this.phase = "sent";
  }
}

function working(host: LocksHost, taskId: string): boolean {
  const state = host.runtimeState(taskId);
  return state !== undefined && state !== "idle";
}
