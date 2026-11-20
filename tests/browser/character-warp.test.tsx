import { expect, test } from "vitest";
import { FIDGET_DURATION_MS } from "../../src/renderer/src/character/machine";
import { WARP_VARIANTS, type WarpVariant } from "../../src/renderer/src/character/warp";
import { fakeBridge } from "./bridge";
import { characters, crewPlaneCounts, firstmateIdle, nearCrew } from "./crew";
import { seededHome, subscribed } from "./freshHome";
import { openWindow } from "./window";

/**
 * The warp fidgets (INF-1755; the captain's ask, INF-1750: "i want this
 * fidget animation to look like the whole crew is traveling through space at
 * warp speed like through a wormhole", and their choice of all three
 * treatments, "add all 3 actually"). A tap on the idle first mate draws a
 * fidget from the pool; the draw is held to one warp by a fixed random
 * number, so each warp plays end to end in turn.
 *
 * Promised result: the warp plays, the crew circling the first mate ride it
 * faster round their orbits, and when it ends the first mate is idle again
 * and the crew are back at their own pace on the same orbits.
 * Data: six seeded idle crew on this computer. Completion signal: the near
 * crew canvas's `data-crew-warp` and `data-crew-travel`, and the first mate
 * idle again.
 */

const CREW = 6;

/** Each warp at real speed, and the wait after it the journey gave each. */
const PLAYS_MS = WARP_VARIANTS.reduce(
  (sum, variant) => sum + FIDGET_DURATION_MS[variant] + 10_000,
  0,
);

/**
 * The fixed random number that draws `variant` from the pool, which draws by
 * key order and never repeats the fidget just played; the first mate's own
 * idle fidget then waits longer than a play takes.
 */
function drawing(variant: WarpVariant | undefined, last: WarpVariant | null): number {
  if (!variant) return 0.5;
  const pool = (Object.keys(FIDGET_DURATION_MS) as WarpVariant[]).filter((v) => v !== last);
  return (pool.indexOf(variant) + 0.5) / pool.length;
}

test(
  "a tap on the idle first mate plays each warp and takes the crew along",
  async () => {
    const bridge = fakeBridge(subscribed(await seededHome({ crew: CREW })));
    // The machine keeps the random source it was built with, so the one
    // stand-in reads which warp the next tap is to draw.
    const random = Math.random;
    let wanted = WARP_VARIANTS[0];
    let last: WarpVariant | null = null;
    Math.random = () => drawing(wanted, last);
    try {
      await openWindow(bridge);
      await firstmateIdle();
      const orbits = await crewPlaneCounts();
      expect(orbits.reduce((sum, n) => sum + n, 0)).toBe(CREW);
      for (const variant of WARP_VARIANTS) {
        wanted = variant;
        const [character] = characters();
        character?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await expect.poll(() => nearCrew().getAttribute("data-crew-warp")).toBe(variant);
        // At warp speed the crew travel their orbits faster than their own pace.
        await expect
          .poll(() => Number(nearCrew().getAttribute("data-crew-travel")), { interval: 50 })
          .toBeGreaterThan(2);
        // The warp ends on its own: the first mate is idle, the crew at their
        // own pace on the orbits they started on.
        await firstmateIdle(FIDGET_DURATION_MS[variant] + 10_000);
        expect(nearCrew().hasAttribute("data-crew-warp")).toBe(false);
        expect(nearCrew().getAttribute("data-crew-travel")).toBe("1");
        expect(await crewPlaneCounts()).toEqual(orbits);
        last = variant;
      }
    } finally {
      Math.random = random;
    }
    expect([...new Set(bridge.unanswered)]).toEqual([]);
  },
  PLAYS_MS,
);
