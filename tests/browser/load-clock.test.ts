import { expect, test } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { seededHome } from "./freshHome";
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
 *
 * A click, a fill or a hover has a limit of its own: the time its test has
 * left, so a stuck one says what it waited for just before the test's limit
 * would. On a busy Mac a test with seconds of load time left once ended at a
 * click given tens of milliseconds, the wall time left (INF-4644). The page
 * now gives each one the load time its test has left (the patched
 * `@vitest/runner`), and the command process, where Playwright keeps that
 * limit, counts it on a load clock of its own (tests/helpers/browserCommandClock.ts).
 *
 * One core boots at a time, so a seeded home waits in line behind the boots
 * other pages asked first, and on that busy Mac a test once spent most of its
 * limit there (INF-4644). The page's clock now counts none of that wait
 * (tests/helpers/browserCommands.ts, `loadReading`).
 */

/** A button that takes a click only `after` milliseconds of the page's time from now, and whether one landed. */
function buttonTakingClicksAfter(after: number): {
  button: HTMLButtonElement;
  pressed: () => boolean;
} {
  const button = document.createElement("button");
  button.textContent = "Press";
  button.disabled = true;
  let pressed = false;
  button.addEventListener("click", () => {
    pressed = true;
  });
  document.body.append(button);
  setTimeout(() => {
    button.disabled = false;
  }, after);
  return { button, pressed: () => pressed };
}

const { grades } = await commands.loadReading();

// The hold blocks the command process's event loop, as a read from a starved
// disk blocks it, for three times the test's limit. A graded run
// (INFINITARY_PERF_BUDGETS=1) keeps the wall clock, so there the hold fails it.
(grades ? test.fails : test)(
  "a test whose command process is held past its limit still passes",
  { timeout: 1_000 },
  async () => {
    const wallStart = performance.now();
    const loadStart = pageLoadClock()?.now();
    await commands.holdCommandProcess(3_000);
    // The wall clock ran the whole hold; the test's own clock counted under its limit.
    expect(performance.now() - wallStart).toBeGreaterThanOrEqual(3_000);
    expect(loadStart).toBeDefined();
    expect((pageLoadClock()?.now() ?? Number.POSITIVE_INFINITY) - (loadStart ?? 0)).toBeLessThan(
      1_000,
    );
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

// The hold takes all but 300 ms of the test's wall time; the click then waits
// 600 ms for its button. On the wall clock the click had 200 ms; it has the
// load time its test has left, nearly all of it.
(grades ? test.fails : test)(
  "a click after its command process was held still has the load time its test has left",
  { timeout: 3_000 },
  async () => {
    await commands.holdCommandProcess(2_700);
    const { button, pressed } = buttonTakingClicksAfter(600);
    try {
      await userEvent.click(button);
      expect(pressed()).toBe(true);
    } finally {
      button.remove();
    }
  },
);

// The click starts with nearly all of its test's second, then the command
// process, where Playwright counts that limit, is held for three. The button
// takes clicks during the hold, so the click lands once the process runs again;
// on the wall clock its limit had passed by then.
(grades ? test.fails : test)(
  "a click whose command process is held past its own limit still lands",
  { timeout: 1_000 },
  async () => {
    const { button, pressed } = buttonTakingClicksAfter(1_500);
    try {
      const clicked = userEvent.click(button).then(() => pressed());
      // Hold once Playwright is waiting for the button, not before it has started.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await commands.holdCommandProcess(3_000);
      expect(await clicked).toBe(true);
    } finally {
      button.remove();
    }
  },
);

// The boot line is held longer than the test's whole limit, as boots other
// pages asked first hold it, and the test's own home boots after the hold.
(grades ? test.fails : test)(
  "a seeded home's wait in line behind other boots does not count against its test",
  { timeout: 4_000 },
  async () => {
    await commands.holdBootLine(5_000);
    const home = await seededHome();
    expect(home["inf:tasks:board"]).toBeDefined();
  },
);
