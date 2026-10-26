import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { readSavedData } from "./savedData";
import { pagerAt, shownCard, shownEntry, stageAtRest } from "./stack";

const titles = [
  "The launch review is ready",
  "Choose the launch window",
  "Keep Friday for the launch",
] as const;

/** INF-1404, captain: a later close must select unread, not the first already-read card.
 * Real saved notes and the real stage/Close control; isolated Electron, no accounts or shared resources.
 * Completion is the unread title on stage, followed by the read-card fallback once none remain.
 */
for (const reload of [false, true]) {
  test(`closing a later card selects the unvisited card ${reload ? "after reload" : "at startup"}`, async () => {
    const userDataDir = scratchDir("infinitary-unread-dismissal-");
    const db = openDatabase(userDataDir);
    try {
      const cards = new CardStore(db);
      titles.forEach((title, index) => {
        cards.upsert({
          id: `launch-${index + 1}`,
          title,
          body: `<p>${["The review is ready to read.", "Keep the launch and its review together.", "Friday leaves room for the review."][index]}</p>`,
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
    const launched = await launchApp({ userDataDir });
    try {
      const { page } = launched;
      await expect(shownCard(page, titles[0])).toBeVisible();
      await page.getByRole("button", { name: "Next card", exact: true }).click();
      await expect(shownCard(page, titles[1])).toBeVisible();
      if (reload) {
        // Wait for the durable look through the read-only saved-data owner before reload.
        await expect
          .poll(() =>
            readSavedData(userDataDir, (saved) =>
              saved
                .prepare(
                  "SELECT offer_id FROM card_observations WHERE card_id = ? AND kind = 'seen'",
                )
                .get("launch-2"),
            ),
          )
          .toBeTruthy();
        await page.reload();
        await expect(shownCard(page, titles[0])).toBeVisible();
        await page.getByRole("button", { name: "Next card", exact: true }).click();
        await expect(shownCard(page, titles[1])).toBeVisible();
      }
      await stageAtRest(page);
      await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(shownCard(page, titles[2])).toBeVisible();
      await expect(pagerAt(page, 2, 2)).toBeVisible();
      await stageAtRest(page);
      await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(shownCard(page, titles[0])).toBeVisible();
    } finally {
      await launched.close();
    }
  });
}
