import { mock } from "node:test";
import { GRADES_BUDGETS, LOAD_CLOCK_TICK_MS, startLoadClock } from "./budgets.ts";

/**
 * INF-1614, the captain's approved test-clock change: the boxed classifier
 * proves the real request and answer, not how fast a busy Mac schedules a
 * cold client. Its process and scorer child run timeout callbacks on the
 * existing load clock. Performance runs keep the native wall clock.
 *
 * Only these disposable test processes opt in. The app and ordinary scorer
 * keep their unchanged deadlines; decisionKindClassifier.test.ts separately
 * drives those deadlines through creation, a hung turn and a deaf abort.
 * The runner's real, capped test deadline still ends a stuck integration.
 */
export function startClassifierTestClock(): () => void {
  if (GRADES_BUDGETS) return () => {};
  // Both clocks and the driver capture real timers before MockTimers installs.
  const clock = startLoadClock();
  const { setInterval, clearInterval } = globalThis;
  const nativeTimeout = AbortSignal.timeout;
  let counted = clock.now();
  mock.timers.enable({ apis: ["setTimeout"] });
  // Node's native AbortSignal.timeout does not use the global setTimeout.
  // The scorer owns that outer deadline; the adapter owns a setTimeout.
  AbortSignal.timeout = (milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        ),
      milliseconds,
    ).unref();
    return controller.signal;
  };
  const driver = setInterval(() => {
    const now = clock.now();
    mock.timers.tick(now - counted);
    counted = now;
  }, LOAD_CLOCK_TICK_MS);
  driver.unref();
  return () => {
    clearInterval(driver);
    clock.stop();
    AbortSignal.timeout = nativeTimeout;
    mock.timers.reset();
  };
}
