import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { pageLoadClock } from "./loadClock";

/**
 * A browser test's limit counts only the time its test got to run, as every
 * other project's does (INF-1083, the captain's choice "a deadline counts
 * only the time the test gets to run, capped at 20 times its budget"), and a
 * flaky test is fixed at its root (the captain's standing direction). A
 * shared runner's starved disk once held the command process inside a seeded
 * home's boot for longer than the test's whole limit, and the page's
 * wall-clock limit failed a test with nothing wrong in it. The page's clock
 * now ticks on a beat the command process answers too (./loadClock.ts).
 */

const { grades } = await commands.loadReading();

// The hold blocks the command process's event loop, as a read from a starved
// disk blocks it, for three times the test's limit. A graded run
// (INFINITARY_PERF_BUDGETS=1) keeps the wall clock, so there the hold fails it.
(grades ? test.fails : test)(
  "a test whose command process is held past its limit still passes",
  { timeout: 1_000 },
  async () => {
    await commands.holdCommandProcess(3_000);
  },
);

test("the page's clock counts the time a test runs, so its limit still ends it", async () => {
  const clock = pageLoadClock();
  if (grades) {
    expect(clock).toBeUndefined();
    return;
  }
  if (!clock) throw new Error("The page keeps no load clock");
  const deadline = clock.now() + 200;
  await new Promise<void>((resolve) => clock.timer(resolve, deadline));
  // Fired by the time it counted, not by its wall cap: a beat that stopped would leave it short.
  expect(clock.now()).toBeGreaterThanOrEqual(deadline);
});
