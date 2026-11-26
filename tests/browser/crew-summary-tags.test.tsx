import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { crewSummary, pointAtCrewmate } from "./crew";
import { seededHome, subscribed } from "./freshHome";
import { within } from "./layout";
import { openSize, openWindow } from "./window";

/**
 * A person's report: on a task carrying several tags, the summary's Tags
 * line ran past the summary's right edge. The tags now wrap inside it, as
 * the task title and the project already did.
 *
 * Data: one idle crewmate on this computer whose task carries the six tags
 * from the report, seeded through the core's own task and tag writers, with
 * a subscription connected.
 * Completion signal: the summary naming the crewmate the pointer rests on,
 * with its Tags line filled in from the task record.
 * Platform prerequisites: none; the page is the app's default window.
 * Shared resources: none beyond the page this file draws its one window in.
 */

/** The tags in the report's picture, longer together than the summary is wide. */
const TAGS = ["Bug", "Enhancement", "Refactor", "Reliability", "Security", "Test system"];

/** The box the words themselves are drawn in, which a cell's own box does not bound. */
function wordsBox(el: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect();
}

test("six tags wrap inside the crewmate's summary instead of running past its edge", async () => {
  const bridge = fakeBridge(subscribed(await seededHome({ tags: TAGS })));
  await openSize();
  await openWindow(bridge);
  const { id } = await pointAtCrewmate();
  await expect.poll(() => crewSummary()?.getAttribute("data-crew-summary")).toBe(id);
  const tags = () => crewSummary()?.querySelector<HTMLElement>('[data-task-fact="tags"]');
  await expect.poll(() => tags()?.textContent).toBe(TAGS.join(", "));
  const summary = crewSummary() as HTMLElement;
  const line = tags() as HTMLElement;
  expect(within(wordsBox(line), summary.getBoundingClientRect())).toEqual([]);
  expect(line.scrollWidth, "nothing in the Tags line is cut").toBeLessThanOrEqual(
    line.clientWidth + 1,
  );
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
