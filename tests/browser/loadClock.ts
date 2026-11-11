import { commands } from "vitest/browser";
import { LOAD_CLOCK_TICK_MS, type LoadClock, tickedLoadClock } from "../helpers/loadClock";

/**
 * The browser project's load clock (INF-1083, the captain's choice "a
 * deadline counts only the time the test gets to run, capped at 20 times its
 * budget"; docs/test-cohorts.md, "Budgets"). Every project whose tests run in
 * Node keeps one in each worker (tests/helpers/waitWindow.ts), so a test's
 * and a hook's limit, and an `expect.poll` or `vi.waitFor` window, count only
 * the time the test got to run and end by their wall cap. The patched
 * `@vitest/runner` and `vitest` read the clock in this page under the same
 * name.
 *
 * A browser test runs in two processes: this page, and the Node process that
 * answers its commands - a seeded home's boot, a read inside a frame, a
 * click. So the clock ticks on a beat both answer: the page's own timer, then
 * the command process's reading. A stall of either - a frozen page, or a
 * command process blocked on a shared runner's starved disk - holds the beat,
 * and the clock stops with it. A graded run (INFINITARY_PERF_BUDGETS=1) keeps
 * the wall clock. The browser project runs this file first, before each file
 * (vitest.config.ts).
 */

const UNIT_CLOCK = Symbol.for("infinitary.unitLoadClock");
const scope = globalThis as { [UNIT_CLOCK]?: LoadClock };

/** The clock this page's limits and waits run on: none on a graded run. */
export function pageLoadClock(): LoadClock | undefined {
  return scope[UNIT_CLOCK];
}

/** A clock ticked by the command process's beat, at the processor share each reading gives. */
function beatingClock(firstShare: number): LoadClock {
  let share = firstShare;
  const clock = tickedLoadClock(performance.now.bind(performance), () => share);
  // The page's timer as it stands now, so a test that fakes the timers later keeps the beat.
  const { setTimeout } = globalThis;
  const beat = () => {
    commands
      .loadReading()
      .then(
        (reading) => {
          share = reading.share;
        },
        // A reading lost as the page moves on to its next file still ends the beat on the page's own time.
        () => undefined,
      )
      .finally(() => {
        clock.tick();
        setTimeout(beat, LOAD_CLOCK_TICK_MS);
      });
  };
  setTimeout(beat, LOAD_CLOCK_TICK_MS);
  return clock;
}

if (!scope[UNIT_CLOCK]) {
  const first = await commands.loadReading();
  if (!first.grades) scope[UNIT_CLOCK] ??= beatingClock(first.share);
}
