import { expect, TestRunner, vi } from "vitest";
import { GRADES_BUDGETS, startUnitLoadClock } from "./budgets";

/**
 * A wait for a state ends when the state arrives, or when its window runs out
 * on the clock its run keeps (captain, INF-857: "we should fix the tests
 * instead and make them robust even during heavy load"; INF-1083, the
 * captain's choice for unit tests: "Yes, as a third piece after these two:
 * today a stuck unit test waits with no clock until GitHub's six-hour limit").
 *
 * On an ordinary run the window counts load time: this setup file starts the
 * worker's load clock (`budgets.ts`), and the patched `vitest` reads it for
 * `expect.poll` and `vi.waitFor`, as the patched `@vitest/runner` does for
 * test and hook limits. A frozen worker's windows stop with it, and each ends
 * by its wall cap, 20 times its window and at most 10 minutes.
 *
 * Either way a wait keeps a window it names, and one that names none lasts
 * its test's budget rather than vitest's one second, ending a little before
 * it so a stuck wait reports its own last mismatch rather than a bare
 * timeout. A graded run counts what is left of the budget on the wall clock;
 * an ordinary run gives the whole budget, since the test's own limit, on the
 * same load clock, still ends the test.
 */
startUnitLoadClock();

/** Time kept back at the end of the test's budget for the wait to report its mismatch. */
const REPORTING_MS = 500;

/** vitest's own window for a wait with no `timeout`. */
const VITEST_WINDOW_MS = 1_000;

export type RunningTest = { timeout?: number; startedAt?: number } | undefined;

/**
 * The window a wait gets: the one it names, else its test's budget less the
 * time to report - on a graded run what is left of it - and vitest's own
 * outside a test.
 */
export function waitWindow(
  named: number | undefined,
  run: { grades: boolean; test: RunningTest; now: number },
): number {
  if (named !== undefined) return named;
  const { timeout, startedAt } = run.test ?? {};
  if (!timeout || startedAt === undefined) return VITEST_WINDOW_MS;
  const spent = run.grades ? run.now - startedAt : 0;
  return Math.max(VITEST_WINDOW_MS, timeout - spent - REPORTING_MS);
}

function windowNow(named: number | undefined): number {
  const test = TestRunner.getCurrentTest();
  return waitWindow(named, {
    grades: GRADES_BUDGETS,
    test: test && { timeout: test.timeout, startedAt: test.result?.startTime },
    now: Date.now(),
  });
}

function withWindow<Options extends { timeout?: number }>(options: Options | undefined): Options {
  return { ...options, timeout: windowNow(options?.timeout) } as Options;
}

const WRAPPED = Symbol.for("infinitary.waitWindow");
type Wrapped = { [WRAPPED]?: true };

// Setup files run again for each file in a shared module cache, so wrap once.
if (!(expect.poll as Wrapped)[WRAPPED]) {
  const poll = expect.poll;
  const windowed = ((fn, options) => poll(fn, withWindow(options))) as typeof expect.poll;
  (windowed as Wrapped)[WRAPPED] = true;
  expect.poll = windowed;
}

if (!(vi.waitFor as Wrapped)[WRAPPED]) {
  const waitFor = vi.waitFor;
  const windowed = ((callback, options) =>
    waitFor(
      callback,
      typeof options === "number" ? windowNow(options) : withWindow(options),
    )) as typeof vi.waitFor;
  (windowed as Wrapped)[WRAPPED] = true;
  vi.waitFor = windowed;
}
