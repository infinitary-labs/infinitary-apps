import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { intersects } from "./layout";
import { inShown } from "./stack";
import { openWindow } from "./window";

/**
 * A card from a task that runs on another computer names where it runs in
 * its head, whatever the length of its task's title (FI3-1019; docs/helper.md,
 * "A card from there"): the title gives way, the place reads whole.
 */

// Longer than a card head has room for at any window size, so the title must give way.
const TITLE =
  "Hello-World answer only - read the README, report its first line, and say whether anything else in the project changed since yesterday";
const PLACE = "on Mac mini";
const CARD = "The README's first line is Hello World";

/** Every character shows: nothing inside it is cut or scrolled out of view. */
const readsWhole = (el: Element) => el.scrollWidth <= el.clientWidth + 1;

/** The shown card's head part `selector`. */
const shownHead = (selector: string) => inShown(`[data-card-head] ${selector}`);

test("a card from a task on another Mac names where it runs whole, however long its task's title", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, place: PLACE, card: CARD }));
  await openWindow(bridge);
  for (const size of [SMALLEST_WINDOW, { width: 1200, height: 800 }]) {
    await page.viewport(size.width, size.height);
    await expect.element(page.getByRole("region", { name: CARD, exact: true })).toBeVisible();
    const place = shownHead("[data-card-place]");
    await expect.element(place).toHaveTextContent(PLACE);
    await expect.element(place).toBeInViewport({ ratio: 1 });
    expect(readsWhole(place), `the place reads whole at ${size.width}x${size.height}`).toBe(true);
    // The title is what gives way, and the place stays clear of the model and close.
    const meta = shownHead("[data-card-meta]");
    expect(meta.textContent).toBe(TITLE);
    expect(readsWhole(meta), "the title gives way").toBe(false);
    const box = place.getBoundingClientRect();
    expect(intersects(box, shownHead("[data-model-chip]").getBoundingClientRect())).toBe(false);
    const close = page.getByRole("button", { name: "Close" }).element();
    expect(intersects(box, close.getBoundingClientRect())).toBe(false);
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
