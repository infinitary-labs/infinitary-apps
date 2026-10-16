import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { ACTIONS } from "../../src/shared/actions";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine } from "./rails";

const PLAN_TITLE = "How to make every view of a task consistent";

/**
 * Asking for an earlier card (FI3-579 piece 4): Firstmate takes the one
 * show-card door and the closed card comes forward on the stage as it was,
 * with no new card made; the shell's own gesture takes the same door.
 */
test("asking Firstmate for an earlier plan shows it read-only on the stage and makes no new card", async () => {
  const userDataDir = scratchDir("infinitary-show-card-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  store.upsert({
    id: "plan-views",
    title: PLAN_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    body: "<p>One status mark for every place a task appears.</p>",
    status: "ready",
    createdAt: Date.now() - 86_400_000,
    actions: [
      { id: "later", label: "Not now" },
      { id: "build", label: "Approve and build" },
    ],
  });
  store.resolve("plan-views", "build");
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    const live = () => page.evaluate(() => window.infinitary.cards.list());
    expect(await live()).toEqual([]);
    await promptInput(page).fill(
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "show-card", value: { cardId: "plan-views" } }),
    );
    await promptInput(page).press("Enter");
    const past = page.locator('[data-past-card="plan-views"]');
    await expect(past).toBeVisible();
    await expect(page.locator("[data-past-title]")).toHaveText(PLAN_TITLE);
    const chosen = page.locator('[data-past-action="build"]');
    await expect(chosen).toBeDisabled();
    await expect(chosen).toHaveAttribute("data-past-chosen", "");
    await expect(feedLine(page, ACTIONS["show-card"].done({ title: PLAN_TITLE }))).toBeVisible();
    await waitForFirstmateIdle(page);
    // Firstmate pointed; it made no card of its own and the saved card is unchanged.
    expect(await live()).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("past-card-shown-by-firstmate.png") });
    // Hide closes the held entry; the shell's own gesture reopens it through the same door.
    await page.keyboard.press("Escape");
    await expect(past).toHaveCount(0);
    await page.evaluate(() => window.infinitary.cards.showPast("plan-views"));
    await expect(past).toBeVisible();
    expect(await live()).toEqual([]);
  } finally {
    await app.close();
  }
});
