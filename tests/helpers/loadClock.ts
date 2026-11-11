/**
 * The load clock's core (INF-1083, the captain's choice "a deadline counts
 * only the time the test gets to run, capped at 20 times its budget"). Node
 * processes start it on a timer of their own (`budgets.ts`); the browser
 * project's page starts it on a beat its command process answers
 * (`tests/browser/loadClock.ts`). Both run this file, so it imports nothing
 * from Node.
 */

/**
 * The longest a wait may take on the wall clock: 20 times its budget, and
 * never more than 10 minutes (INF-1083, the captain's choice "20 times its
 * budget, at most 10 minutes"). Twenty times covers the load controller's
 * 65-second freeze on a 5-second wait; ten minutes ends an impossible one well
 * before the whole check's own limit.
 */
export function waitCap(budget: number): number {
  return Math.min(20 * Math.max(0, budget), 600_000);
}

/** A deadline timer's handle: `cancel` stops it, `unref` lets the process exit first. */
export type DeadlineTimer = { cancel(): void; unref(): DeadlineTimer };

/**
 * The load clock. Its reading, in milliseconds, advances with the wall clock
 * while the work it times runs and the computer has a processor free for each
 * thread waiting to run. It stops while that work is stalled - stopped, or
 * not scheduled - and slows by the share of processors left when the
 * one-minute load per processor is above 1.
 *
 * A stall shows as a tick that arrives late: of each gap between ticks, at
 * most two ticks' worth counts, so a 65-second freeze counts 50 milliseconds.
 * Load time never runs ahead of the wall clock, and every timer still fires
 * by its wall cap, so a wait that never sees its work still fails.
 */
export type LoadClock = {
  now(): number;
  /** Fires once `now()` reaches `deadline`, or `waitCap` of the time left has passed on the wall clock. */
  timer(fire: () => void, deadline: number): DeadlineTimer;
};

/** The sampling cadence, also used by the isolated classifier's test-only timer driver. */
export const LOAD_CLOCK_TICK_MS = 25;

/** The share of a processor each waiting thread gets: all of one until the one-minute load per processor passes 1. */
export function processorShare(load: number, processors: number): number {
  return Math.min(1, processors / Math.max(processors, load));
}

type Pending = ReturnType<typeof setTimeout>;

/** Node's timers can let the process exit before they fire; a page's have no such handle. */
function unrefTimer(timer: Pending | undefined): void {
  (timer as { unref?: () => unknown } | undefined)?.unref?.();
}

/**
 * A load clock that advances only on the ticks its owner sends, each counting
 * the gap since the last at the processor share `share` gave at that last
 * tick. Its owner ticks it every `LOAD_CLOCK_TICK_MS` while the work it times
 * runs, and a tick that the work's stall holds back counts only its two ticks.
 */
export function tickedLoadClock(
  wall: () => number,
  share: () => number,
): LoadClock & { tick(): void } {
  // The timers as they stand at the start, so a unit test that fakes them later keeps its limits on real time.
  const { setTimeout, clearTimeout } = globalThis;
  let counted = 0;
  let last = wall();
  let current = 1;
  const pending = () => Math.min(wall() - last, 2 * LOAD_CLOCK_TICK_MS) * current;
  const tick = () => {
    counted += pending();
    last = wall();
    current = share();
  };
  const now = () => counted + pending();
  return {
    now,
    tick,
    timer(fire, deadline) {
      const armed = wall();
      const cap = waitCap(deadline - now());
      let pendingTimer: Pending | undefined;
      let unref = false;
      const check = () => {
        // Load time never outruns the wall clock, so waiting the load time left never overshoots.
        const left = Math.min(deadline - now(), cap - (wall() - armed));
        if (left <= 0) return fire();
        pendingTimer = setTimeout(check, left);
        if (unref) unrefTimer(pendingTimer);
      };
      pendingTimer = setTimeout(check, Math.max(0, Math.min(deadline - now(), cap)));
      const handle: DeadlineTimer = {
        cancel: () => clearTimeout(pendingTimer),
        unref: () => {
          unref = true;
          unrefTimer(pendingTimer);
          return handle;
        },
      };
      return handle;
    },
  };
}
