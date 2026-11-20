import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { crewPlaneCounts, crewSummary, nearCrew, pointAtCrewmate } from "./crew";
import { seededHome, subscribed } from "./freshHome";
import { intersects, windowBox, within } from "./layout";
import { messageBox } from "./prompt";
import { openWindow } from "./window";

/**
 * The growing ring at its fullest (INF-1179's accepted orbit layout;
 * docs/crew-orbits.md): with both orbits crowded, at the smallest window,
 * every crewmate is on the stage, the crowded orbit stays inside the window
 * and clear of the message box, and pointing at one crewmate still opens its
 * summary whole inside the window.
 *
 * Data: 48 idle crew seeded on this computer through the core's own task
 * store, with a subscription connected.
 * Completion signal: the near crew canvas's `data-plane-counts`, and the
 * summary naming the crewmate the pointer rests on.
 * Platform prerequisites: none; the page is sized to the smallest window.
 * Shared resources: none beyond the page this file draws its one window in.
 */

const CREW = 48;

/** Where the crowded orbit breaks the layout: past the window's edges, or over the message box. */
function orbitLosses(): string[] {
  const orbit = nearCrew().getBoundingClientRect();
  const box = messageBox();
  if (!box) return ["message box missing"];
  const losses = within(orbit, windowBox());
  if (intersects(orbit, box.getBoundingClientRect())) losses.push("covers the message box");
  return losses;
}

test(`at the smallest window ${CREW} crew all fit the stage above the prompt, and a crewmate can still be read`, async () => {
  const bridge = fakeBridge(subscribed(await seededHome({ crew: CREW })));
  // The core booted on the seed counts every crewmate idle, none restarted.
  expect((await bridge.api.crew.counts()).idle).toBe(CREW);
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  await openWindow(bridge);
  // Every crewmate is on the stage.
  await expect
    .poll(async () => (await crewPlaneCounts()).reduce((sum, n) => sum + n, 0))
    .toBe(CREW);
  // The crowded orbit stays in the window and clear of the prompt, as the
  // crew are placed and again once the planes have opened out to their orbits.
  expect(orbitLosses()).toEqual([]);
  await expect
    .poll(() => nearCrew().getAttribute("data-plane-blend"), {
      message: "The planes have not opened out to their orbits",
      timeout: 30_000,
    })
    .toBe("1");
  expect(orbitLosses()).toEqual([]);
  // Pointing at one opens its summary, whole inside the window. Read once it
  // has settled: the task record fills it in after it opens, and the next
  // frame places it again for its new size.
  const { id } = await pointAtCrewmate();
  await expect.poll(() => crewSummary()?.getAttribute("data-crew-summary")).toBe(id);
  await expect.element(crewSummary() as HTMLElement).toBeVisible();
  await expect
    .poll(() => {
      const summary = crewSummary();
      return summary ? within(summary.getBoundingClientRect(), windowBox()) : ["summary missing"];
    })
    .toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
