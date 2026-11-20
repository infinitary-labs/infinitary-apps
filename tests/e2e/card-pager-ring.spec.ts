import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { expectUpdateSeen, pagerAt, shownCard } from "./stack";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

/**
 * INF-4541, the captain's approved plan for a user's two asks: "N new" takes
 * you to the new cards, and the pager's arrows go round past either end.
 * Data: four ready first mate notes saved before launch, none of them seen.
 * Isolated Electron, no accounts or shared resources. Completion: each press
 * of the new-card key or the badge, made as soon as the window has seen the
 * card before it and before the owner's mark returns, brings up the next new card in the pager's order, ⇧⌘] on the last card shows the first and ⇧⌘[ on the first the last,
 * and the next arrow keeps keyboard focus as it goes round.
 */
const titles = [
  "Tide table for Friday",
  "Crane booking moved",
  "Harbour fees paid",
  "Survey boat is back",
] as const;

/** "N new" as a button: a new card besides the shown one is on the pager. */
const newBadge = (page: Page) => page.locator("[data-card-new]");

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("the new-card key and badge show each new card, and the arrows go round past either end", async ({}) => {
  const userDataDir = scratchDir("infinitary-pager-ring-");
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    titles.forEach((title, index) => {
      cards.upsert({
        id: `ring-${index + 1}`,
        title,
        body: `<p>${title}.</p>`,
        author: "firstmate",
        meta: "firstmate",
        priority: 20,
        status: "ready",
        actions: [],
        createdAt: Date.now() + index,
      });
    });
  } finally {
    db.close();
  }
  const { app, page, close } = await launchApp({ userDataDir });
  try {
    await expect(shownCard(page, titles[0])).toBeVisible();
    // The hidden test window gains focus, so the shown card's sighting reaches the owner.
    await shownCard(page, titles[0]).locator("[data-card-title]").click();
    await expectUpdateSeen(page, "ring-1");
    await expect(newBadge(page)).toHaveText("3 new");

    // INF-4547 review, the captain's pick: each press reaches a new card it has not shown, never
    // waiting for the owner's seen mark of the one before. The count drops with the window's own
    // sighting (the shown card counts until then), so waiting for it keeps a press from leaving a
    // card before its sighting forms; presses with no sighting at all are stackActions.test.ts's.
    await test.step("quick presses of the new-card key and the badge show each new card in the pager's order", async () => {
      await pressWindowKey(app, "]", ["meta", "alt", "shift"]);
      await expect(shownCard(page, titles[1])).toBeVisible();
      await expect(pagerAt(page, 2, 4)).toBeVisible();
      await expect(newBadge(page)).toHaveText("2 new");
      await newBadge(page).click();
      await expect(shownCard(page, titles[2])).toBeVisible();
      await expect(newBadge(page)).toHaveText("1 new");
      await pressWindowKey(app, "]", ["meta", "alt", "shift"]);
      await expect(shownCard(page, titles[3])).toBeVisible();
      await expect(pagerAt(page, 4, 4)).toBeVisible();
      await expectUpdateSeen(page, "ring-4");
      // No other card is new: the count, and its button, are gone.
      await expect(newBadge(page)).toHaveCount(0);
    });

    await test.step("⇧⌘] on the last card shows the first, and ⇧⌘[ on the first the last", async () => {
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(shownCard(page, titles[0])).toBeVisible();
      await expect(pagerAt(page, 1, 4)).toBeVisible();
      await pressWindowKey(app, "[", ["meta", "shift"]);
      await expect(shownCard(page, titles[3])).toBeVisible();
      await expect(pagerAt(page, 4, 4)).toBeVisible();
    });

    await test.step("the next arrow keeps keyboard focus as it goes round", async () => {
      const next = page.getByRole("button", { name: "Next card", exact: true });
      await focusOn(next);
      await pressKey(next, "Enter");
      await expect(shownCard(page, titles[0])).toBeVisible();
      await expect(pagerAt(page, 1, 4)).toBeVisible();
      await expect(next).toBeFocused();
    });
  } finally {
    await close();
  }
});
