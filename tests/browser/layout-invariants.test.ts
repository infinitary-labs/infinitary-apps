import { expect, test } from "vitest";
import { commands } from "vitest/browser";

/**
 * INF-1599: the journeys' layout invariant (`clearOfLosses` and
 * `expectClearOf`, tests/e2e/layout.ts) checked on fixed boxes, so it refuses
 * at once rather than waiting out a product layout's settling. It runs on a
 * plain Chromium page through `layoutReadings` (tests/helpers/journeyHelperPages.ts),
 * where the journey launched the whole app to place two boxes (INF-2456).
 */
test("the layout invariant accepts any clear side and refuses overlap, escape and a missing control", async () => {
  const clear = [
    { left: 100, top: 200 },
    { left: 300, top: 200 },
    { left: 200, top: 100 },
    { left: 200, top: 300 },
  ];
  const readings = await commands.layoutReadings([
    ...clear,
    // Over its control.
    { left: 200, top: 200 },
    { left: -20, top: 200 },
    // Clear of where its control was, and the control gone.
    { left: 100, top: 200, controlRemoved: true },
  ]);
  expect(readings).toEqual([
    ...clear.map(() => ({ losses: [], accepted: true })),
    { losses: ["covers control 0"], accepted: false },
    { losses: [expect.stringMatching(/left by/)], accepted: false },
    { losses: ["control 0 missing"], accepted: false },
  ]);
});
