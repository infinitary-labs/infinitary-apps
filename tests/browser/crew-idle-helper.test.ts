import { expect, test } from "vitest";
import { commands } from "vitest/browser";

/**
 * The journeys' first mate idle wait (`waitForFirstmateIdle`,
 * tests/e2e/crew.ts) resolves only on an idle the character has drawn: its
 * canvas mounts reading idle before its first frame starts the opening
 * greet, so a journey that took that label for an idle would start before
 * the first mate is ready. The startup order is driven explicitly on a
 * stand-in canvas, without depending on a loaded Mac, on a plain Chromium
 * page through `firstmateIdleReadings` (tests/helpers/journeyHelperPages.ts),
 * where the journey launched the whole app to replace its page (INF-2456).
 */
test("idle wait requires a drawn character after the opening greet", async () => {
  expect(await commands.firstmateIdleReadings()).toEqual([
    // The helper has read the undrawn idle, but must still be waiting.
    { read: "First mate - idle", resolved: false },
    // A drawn greet is not idle either.
    { read: "First mate - greet", resolved: false },
    // A drawn idle, on a hidden canvas, resolves it.
    { read: "First mate - idle", resolved: true },
  ]);
});
