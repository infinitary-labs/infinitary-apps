import { afterEach, expect, it, vi } from "vitest";

// INF-1614: the captain approved load time for ordinary boxed classifier
// runs, native wall time for graded runs, and no changed production deadline.
const reading = vi.hoisted(() => ({ milliseconds: 0, grades: false, stop: vi.fn() }));
vi.mock("./helpers/budgets.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helpers/budgets")>()),
  get GRADES_BUDGETS() {
    return reading.grades;
  },
  startLoadClock: () => ({ now: () => reading.milliseconds, stop: reading.stop }),
}));

import { LOAD_CLOCK_TICK_MS } from "./helpers/budgets";
import { startClassifierTestClock } from "./helpers/classifierClock";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  reading.milliseconds = 0;
  reading.grades = false;
  reading.stop.mockClear();
});

it("drives both decision deadline forms by counted time and restores native timers", () => {
  // Control only the real driver's cadence. Node's timeout implementation,
  // used by the SDK and adapter, is the one the helper actually installs.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const native = { setTimeout, clearTimeout, abort: AbortSignal.timeout };
  stop = startClassifierTestClock();
  const budget = LOAD_CLOCK_TICK_MS * 4;
  const fired = vi.fn();
  const cancelled = vi.fn();
  const timer = setTimeout((answer: string) => fired(answer), budget, "answer").unref();
  const discard = setTimeout(cancelled, budget);
  clearTimeout(discard);
  const signal = AbortSignal.timeout(budget);

  // The process can spend wall time frozen or waiting for a processor;
  // the established load-clock owner supplies no elapsed work in that case.
  vi.advanceTimersByTime(budget * 2);
  expect(fired).not.toHaveBeenCalled();
  expect(signal.aborted).toBe(false);
  reading.milliseconds = budget - 1;
  vi.advanceTimersByTime(LOAD_CLOCK_TICK_MS);
  expect(fired).not.toHaveBeenCalled();
  expect(signal.aborted).toBe(false);
  reading.milliseconds = budget;
  vi.advanceTimersByTime(LOAD_CLOCK_TICK_MS);
  expect(fired).toHaveBeenCalledExactlyOnceWith("answer");
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toMatchObject({ name: "TimeoutError" });
  expect(cancelled).not.toHaveBeenCalled();
  clearTimeout(timer);

  stop();
  stop = undefined;
  expect(reading.stop).toHaveBeenCalledOnce();
  expect(setTimeout).toBe(native.setTimeout);
  expect(clearTimeout).toBe(native.clearTimeout);
  expect(AbortSignal.timeout).toBe(native.abort);
});

it("leaves all deadlines native in a performance run", () => {
  reading.grades = true;
  const native = { setTimeout, clearTimeout, abort: AbortSignal.timeout };
  stop = startClassifierTestClock();
  expect(setTimeout).toBe(native.setTimeout);
  expect(clearTimeout).toBe(native.clearTimeout);
  expect(AbortSignal.timeout).toBe(native.abort);
  stop();
  stop = undefined;
  expect(reading.stop).not.toHaveBeenCalled();
});
