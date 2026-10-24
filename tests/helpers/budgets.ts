import { availableParallelism, loadavg } from "node:os";

/**
 * Whether this run grades durations against their budgets (captain's B1,
 * "one clock, budgets measured", 2026-09-24; INF-857, the captain's choice:
 * "Grade durations only on a quiet run, as journeys already do").
 *
 * A duration measured on a host running other work grades the load, not the
 * code, so only a run on a quiet host with INFINITARY_PERF_BUDGETS=1 holds a
 * test to its budget: `verify.yml`'s on-demand `perf` input. On every other
 * run a journey's waits run on the load clock below, and a unit test waits
 * for its work with no clock, the job's own time limit stopping a stuck one.
 * The e2e budgets read this through `tests/e2e/perf.ts`; vitest's test and
 * hook limits read the same variable in the one-line patch of
 * `@vitest/runner` (`patches/`), and its waits through `waitWindow.ts`.
 */
export const GRADES_BUDGETS = process.env.INFINITARY_PERF_BUDGETS === "1";

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
 * The load clock (INF-1083, the captain's choice "a deadline counts only the
 * time the test gets to run, capped at 20 times its budget"). Its reading, in
 * milliseconds, advances with the wall clock while this process runs and the
 * Mac has a processor free for each thread waiting to run. It stops while the
 * process is stalled - stopped, or not scheduled - and slows by the share of
 * processors left when the one-minute load per processor is above 1.
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

const TICK_MS = 25;

export function startLoadClock(
  wall: () => number = () => performance.now(),
  load: () => number = () => loadavg()[0] ?? 0,
  processors = availableParallelism(),
): LoadClock & { tick(): void; stop(): void } {
  let counted = 0;
  let last = wall();
  let share = 1;
  const pending = () => Math.min(wall() - last, 2 * TICK_MS) * share;
  const tick = () => {
    counted += pending();
    last = wall();
    share = Math.min(1, processors / Math.max(processors, load()));
  };
  const ticker = setInterval(tick, TICK_MS);
  ticker.unref();
  const now = () => counted + pending();
  return {
    now,
    tick,
    stop: () => clearInterval(ticker),
    timer(fire, deadline) {
      const armed = wall();
      const cap = waitCap(deadline - now());
      let pendingTimer: NodeJS.Timeout | undefined;
      let unref = false;
      const check = () => {
        // Load time never outruns the wall clock, so waiting the load time left never overshoots.
        const left = Math.min(deadline - now(), cap - (wall() - armed));
        if (left <= 0) return fire();
        pendingTimer = setTimeout(check, left);
        if (unref) pendingTimer.unref();
      };
      pendingTimer = setTimeout(check, Math.max(0, Math.min(deadline - now(), cap)));
      const handle: DeadlineTimer = {
        cancel: () => clearTimeout(pendingTimer),
        unref: () => {
          unref = true;
          pendingTimer?.unref();
          return handle;
        },
      };
      return handle;
    },
  };
}

const CLOCK = Symbol.for("infinitary.loadClock");

/**
 * The clock this process's waits run on: a Playwright test worker's on an
 * ordinary run, where the patched `playwright` and `playwright-core` read it
 * at every wait deadline (`patches/`). A graded run, the runner's own process
 * and every other process keep the wall clock.
 */
export const loadClock: LoadClock | undefined = (() => {
  if (GRADES_BUDGETS || process.env.TEST_WORKER_INDEX === undefined) return undefined;
  const scope = globalThis as { [CLOCK]?: LoadClock };
  scope[CLOCK] ??= startLoadClock();
  return scope[CLOCK];
})();

/**
 * A test's own failure timer, never a stimulus, a poll interval or a product
 * deadline: it fires after `milliseconds` of load time on an ordinary journey
 * run, by its wall cap at the latest, and after `milliseconds` on the wall
 * clock everywhere else.
 */
export function budgetTimer(fail: () => void, milliseconds: number): DeadlineTimer {
  if (loadClock) return loadClock.timer(fail, loadClock.now() + milliseconds);
  const timer = setTimeout(fail, milliseconds);
  const handle: DeadlineTimer = {
    cancel: () => clearTimeout(timer),
    unref: () => {
      timer.unref();
      return handle;
    },
  };
  return handle;
}
