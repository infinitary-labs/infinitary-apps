import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { answerStack, shownEntry, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * The stack's depth sits behind the front card (design skill CardStack:
 * "depth comes from their offset and hairline"). The captain reported the
 * top of the stack drawn wrong: each peek, the strip of a card behind,
 * overlaps the front card's top edge by one step and was painted over it,
 * hiding the front card's top border and notching its rounded corners. The
 * front card owns every point of its own top edge, so a point there finds
 * the front card, never a peek.
 */

/** What a point on the front card's top edge finds: the front card, a peek, or another element. */
function topEdgeHits(): Record<string, string> {
  const entry = shownEntry();
  const front = entry?.querySelector("[data-card-surface], [data-response-card]");
  if (!front) throw new Error("The shown entry draws no card");
  const r = front.getBoundingClientRect();
  // Each peek reaches one step into the card from above, so these points
  // all lie where a peek overlaps the front card.
  const points = {
    "top border": [r.left + r.width / 2, r.top + 0.5],
    "just inside the top": [r.left + r.width / 2, r.top + 3],
    "top-left corner": [r.left + 10, r.top + 4],
    "top-right corner": [r.right - 10, r.top + 4],
  } as const;
  return Object.fromEntries(
    Object.entries(points).map(([name, [x, y]]) => {
      const hit = document.elementFromPoint(x, y);
      return [
        name,
        hit?.closest("[data-card-peek]")
          ? "peek"
          : hit && front.contains(hit)
            ? "front card"
            : (hit?.tagName ?? "nothing"),
      ];
    }),
  );
}

const FRONT_OWNS_ITS_EDGE = {
  "top border": "front card",
  "just inside the top": "front card",
  "top-left corner": "front card",
  "top-right corner": "front card",
};

test("the front card draws over the peeks behind it with three cards stacked, then two", async () => {
  const home = await seededHome({ count: 3 });
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await page.viewport(1280, 800);
  await openWindow(bridge);

  for (const [front, count] of [
    [1, 3],
    [2, 2],
  ] as const) {
    const title = `Stacked card ${front}`;
    await expect.element(page.getByRole("region", { name: title, exact: true })).toBeVisible();
    await expect
      .poll(() => shownEntry()?.querySelectorAll("[data-card-peek]").length)
      .toBe(count - 1);
    await stageAtRest();
    expect(topEdgeHits(), `with ${count} cards, the front card's top edge is its own`).toEqual(
      FRONT_OWNS_ITS_EDGE,
    );
    if (count > 2)
      await userEvent.click(
        page.elementLocator(shownEntry() as HTMLElement).getByRole("button", {
          name: "Close",
          exact: true,
        }),
      );
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
