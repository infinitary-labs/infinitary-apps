import { expect, TestRunner, vi } from "vitest";
import { GRADES_BUDGETS } from "./budgets";

/**
 * A wait for a state ends when the state arrives, never on a clock of its own
 * (captain, INF-857: "we should fix the tests instead and make them robust
 * even during heavy load"; his choice: "Grade durations only on a quiet run,
 * as journeys already do. Elsewhere a test waits for its event with no
 * clock, and the job's own time limit stops a stuck one").
 *
 * `expect.poll` and `vi.waitFor` give up after their window, vitest's one
 * second unless they name one: on a Mac that freezes a test's processes for
 * seconds at a time, the state arrives a moment later and the test fails
 * with the work done. So on an ordinary run every wait lasts until its state
 * arrives. On a run that grades budgets (`budgets.ts`), a wait keeps a window
 * it names, and one that names none lasts the rest of its test's budget,
 * ending a little before it so a stuck wait reports its own last mismatch
 * rather than a bare timeout.
 */

/** Time kept back at the end of the test's budget for the wait to report its mismatch. */
const REPORTING_MS = 500;

/** vitest's own window for a wait with no `timeout`. */
const VITEST_WINDOW_MS = 1_000;

/** The longest delay a Node timer takes: a longer one, Infinity included, fires at once. */
const NO_WINDOW_MS = 2 ** 31 - 1;

/** What the running test is: its budget and when it started, when there is one. */
export type RunningTest = { timeout?: number; startedAt?: number } | undefined;

/**
 * The window a wait gets: none on an ordinary run; on a graded run the one it
 * names, else the rest of its test's budget less the time to report, and
 * vitest's own outside a test.
 */
export function waitWindow(
  named: number | undefined,
  run: { grades: boolean; test: RunningTest; now: number },
): number {
  if (!run.grades) return NO_WINDOW_MS;
  if (named !== undefined) return named;
  const { timeout, startedAt } = run.test ?? {};
  if (!timeout || startedAt === undefined) return VITEST_WINDOW_MS;
  return Math.max(VITEST_WINDOW_MS, startedAt + timeout - run.now - REPORTING_MS);
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
