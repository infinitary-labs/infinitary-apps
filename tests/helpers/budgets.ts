import type { Server } from "node:http";
import { availableParallelism, loadavg } from "node:os";
import {
  type DeadlineTimer,
  LOAD_CLOCK_TICK_MS,
  type LoadClock,
  processorShare,
  tickedLoadClock,
  waitCap,
} from "./loadClock.ts";

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

export { type DeadlineTimer, LOAD_CLOCK_TICK_MS, type LoadClock, waitCap };

/**
 * A Node process's load clock (`loadClock.ts`), ticked by a timer of its own
 * every `LOAD_CLOCK_TICK_MS`, at the share of a processor this computer's
 * one-minute load leaves.
 */
export function startLoadClock(
  wall: () => number = performance.now.bind(performance),
  load: () => number = () => loadavg()[0] ?? 0,
  processors = availableParallelism(),
): LoadClock & { tick(): void; stop(): void } {
  // The timers as they stand at the start, so a unit test that fakes them later keeps its limits on real time.
  const { setInterval, clearInterval } = globalThis;
  const clock = tickedLoadClock(wall, () => processorShare(load(), processors));
  const ticker = setInterval(clock.tick, LOAD_CLOCK_TICK_MS);
  ticker.unref();
  return { ...clock, stop: () => clearInterval(ticker) };
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
 * window on an ordinary run. `waitWindow.ts`, a setup file of every project
 * whose tests run in Node, starts it before any test can fake the timers; the
 * browser project's page keeps one under the same name, ticked by its command
 * process (`tests/browser/loadClock.ts`). It is a clock of its own,
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
