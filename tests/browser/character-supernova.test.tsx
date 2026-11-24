import { expect, test } from "vitest";
import { FIDGET_DURATION_MS } from "../../src/renderer/src/character/machine";
import { fakeBridge } from "./bridge";
import { characters, crewPlaneCounts, firstmateIdle, nearCrew } from "./crew";
import { seededHome, subscribed } from "./freshHome";
import { openWindow } from "./window";

/**
 * The supernova fidget (the captain's ask: "one more fidget animation added
 * to the pool for the first mate character that's somewhat like a supernova
 * explosion", and their approved preview, whose blast reaches through the
 * crew). A tap on the idle first mate draws a fidget from the pool; the draw
 * is held to the supernova by a fixed random number.
 *
 * Promised result: the supernova plays and reaches the crew circling the
 * first mate, and when it ends the first mate is idle again and the crew are
 * on the orbits they started on.
 * Data: six seeded idle crew on this computer. Completion signal: the near
 * crew canvas's `data-crew-supernova`, and the first mate idle again.
 */

const CREW = 6;
const PLAY_MS = FIDGET_DURATION_MS.supernova + 10_000;

test(
  "a tap on the idle first mate can play the supernova through the crew",
  async () => {
    const bridge = fakeBridge(subscribed(await seededHome({ crew: CREW })));
    // The machine keeps the random source it was built with, and draws by
    // key order, so this one number draws the supernova on the first tap.
    const random = Math.random;
    const pool = Object.keys(FIDGET_DURATION_MS);
    Math.random = () => (pool.indexOf("supernova") + 0.5) / pool.length;
    try {
      await openWindow(bridge);
      await firstmateIdle();
      const orbits = await crewPlaneCounts();
      expect(orbits.reduce((sum, n) => sum + n, 0)).toBe(CREW);
      const [character] = characters();
      character?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await expect.poll(() => nearCrew().getAttribute("data-crew-supernova")).toBe("playing");
      await firstmateIdle(PLAY_MS);
      expect(nearCrew().hasAttribute("data-crew-supernova")).toBe(false);
      expect(await crewPlaneCounts()).toEqual(orbits);
    } finally {
      Math.random = random;
    }
    expect([...new Set(bridge.unanswered)]).toEqual([]);
  },
  PLAY_MS + 30_000,
);
