import type { Server } from "node:http";
import { availableParallelism, loadavg } from "node:os";

/**
 * Whether this run grades durations against their budgets (captain's B1,
 * "one clock, budgets measured", 2026-09-24; INF-857, the captain's choice:
 * "Grade durations only on a quiet run, as journeys already do").
 *
 * A duration measured on a host running other work grades the load, not the
 * code, so only a run on a quiet host with INFINITARY_PERF_BUDGETS=1 holds a
 * test to its budget: `verify.yml`'s on-demand `perf` input. On every other
 * run a journey's and a unit test's waits run on the load clock below. The
 * e2e budgets read this through `tests/e2e/perf.ts`; vitest's test and hook
 * limits and its waits read the clock `startUnitLoadClock` starts, through
 * the patches of `@vitest/runner` and `vitest` (`patches/`).
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

/** The sampling cadence, also used by the isolated classifier's test-only timer driver. */
export const LOAD_CLOCK_TICK_MS = 25;

export function startLoadClock(
  wall: () => number = performance.now.bind(performance),
  load: () => number = () => loadavg()[0] ?? 0,
  processors = availableParallelism(),
): LoadClock & { tick(): void; stop(): void } {
  // The timers as they stand at the start, so a unit test that fakes them later keeps its limits on real time.
  const { setInterval, setTimeout, clearInterval, clearTimeout } = globalThis;
  let counted = 0;
  let last = wall();
  let share = 1;
  const pending = () => Math.min(wall() - last, 2 * LOAD_CLOCK_TICK_MS) * share;
  const tick = () => {
    counted += pending();
    last = wall();
    share = Math.min(1, processors / Math.max(processors, load()));
  };
  const ticker = setInterval(tick, LOAD_CLOCK_TICK_MS);
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
const scope = globalThis as { [CLOCK]?: LoadClock };

/** The native phone launcher opts its Node failure timers into the same clock as journeys. */
export function startPhoneLoadClock(): void {
  if (!GRADES_BUDGETS) scope[CLOCK] ??= startLoadClock();
}

const UNIT_CLOCK = Symbol.for("infinitary.unitLoadClock");

/**
 * A vitest worker's clock, which the patched `@vitest/runner` and `vitest`
 * read for every test and hook limit and every `expect.poll` and `vi.waitFor`
 * window on an ordinary run. `waitWindow.ts`, a setup file of every project,
 * starts it before any test can fake the timers. It is a clock of its own,
 * not `budgetTimer`'s: a unit test that drives a helper's failure timer with
 * fake timers keeps that timer on the time it fakes.
 */
export function startUnitLoadClock(): void {
  const unitScope = globalThis as { [UNIT_CLOCK]?: LoadClock };
  if (!GRADES_BUDGETS) unitScope[UNIT_CLOCK] ??= startLoadClock();
}

/** Only the disposable home's control server, never the app's transport.
 * A queued POST survives a frozen home, but an unused connection still closes by a finite cap.
 */
export function keepControlConnection(server: Server): void {
  if (!GRADES_BUDGETS) server.keepAliveTimeout = waitCap(server.keepAliveTimeout);
}

/**
 * The clock this process's waits run on: a Playwright test worker's on an
 * ordinary run, where the patched `playwright` and `playwright-core` read it
 * at every wait deadline (`patches/`). The native launcher explicitly opts
 * into the same shared clock. A graded run, the journey runner's own process
 * and processes that did not opt in keep the wall clock.
 */
export const loadClock: LoadClock | undefined = (() => {
  if (GRADES_BUDGETS || process.env.TEST_WORKER_INDEX === undefined) return undefined;
  scope[CLOCK] ??= startLoadClock();
  return scope[CLOCK];
})();

/**
 * A test's own failure timer, never a stimulus, a poll interval or a product
 * deadline: it fires after `milliseconds` of load time on an ordinary journey
 * or native phone run, by its wall cap at the latest, and after `milliseconds`
 * on the wall clock everywhere else.
 */
export function budgetTimer(fail: () => void, milliseconds: number): DeadlineTimer {
  const clock = scope[CLOCK];
  if (clock) return clock.timer(fail, clock.now() + milliseconds);
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
