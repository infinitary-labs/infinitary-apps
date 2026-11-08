import { expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  dockFrameElement,
  dockRegion,
  dockSummaryLine,
  dockTitle,
  nowFrame,
  startedLine,
  taskKey,
} from "./rails";
import { focusOn, pressKey, untilFocused } from "./windowKeys";

/**
 * D5, the two side rails, against the built app (docs/ui-plugins.md). Since
 * phase 2 the left rail carries the Activity feed as a Tier-2 frame - and
 * since task-system P4 the right rail carries Tasks. Activity is present in
 * the default layout, while Tasks opens with its first board row. The tests
 * prove host-owned chrome and collapse,
 * lack of resize affordances, and home-only rendering. That a rail holds
 * every panel placed on it is unit-tested
 * (src/renderer/src/personal/personalPlugins.test.ts).
 *
 * Each test starts from a fresh app and arranges the home it needs: the
 * docked cases commission their own task, so a failed case never leaves a
 * later one looking at an empty home (docs/testing.md).
 */

/** The one task the rails spec commissions. */
const TITLE = "refactor the auth middleware";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp({ withMockProvider: true });
  await expect(launched.page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Null state",
  );
});

test.afterEach(async () => {
  await launched.close();
});

/**
 * The docked home: the spec's one task commissioned the way the captain
 * does, until its started line is in the feed and its row is in the now
 * panel. Returns the task's key.
 */
async function commissionFirstTask(page: Page): Promise<string> {
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
  await input.press("Enter");
  const key = await taskKey(page, TITLE);
  await expect(startedLine(page, key)).toBeVisible({ timeout: 20_000 });
  // The now panel has content - the crewmate stays in the working group
  // whether it is still working or has reported and gone idle.
  await expect(page.locator('[data-side-panel="now"] [data-side-panel-compact]')).toContainText(
    "working",
    { timeout: 20_000 },
  );
  await expect(nowFrame(page).locator("[data-now-group]").first()).toBeVisible({ timeout: 20_000 });
  return key;
}

test("collapse is host chrome: the header stays, the body goes out of sight, the rail stays open", async () => {
  const { page } = launched;
  const activity = page.locator('[data-side-panel="activity"]');
  const title = activity.locator("header");
  // Before the first line, the collapsed header carries the panel's title.
  await expect(activity).toHaveAttribute("data-side-panel-collapsed", "");
  await expect(dockSummaryLine(page, "activity")).toHaveCount(0);
  await expect(title).toContainText(dockTitle("activity"));
  const key = await commissionFirstTask(page);
  await page.getByRole("button", { name: "Collapse Activity" }).click();
  // Its page runs on, out of sight, and says what it holds in the header:
  // the newest line in the title's place.
  await expect(activity.locator("[data-side-panel-body]")).toBeHidden();
  await expect(dockFrameElement(page, "activity")).toBeHidden();
  await expect(dockSummaryLine(page, "activity")).toBeVisible();
  await expect(title).not.toContainText(dockTitle("activity"));
  await expect(dockRegion(page, "activity")).toBeVisible();

  // A newer line takes its place, and the one it replaced leaves.
  const words = dockSummaryLine(page, "activity").locator("[data-panel-summary-words]");
  const before = await words.innerText();
  const said = "check the release notes before the alpha";
  const input = promptInput(page);
  await input.fill(said);
  await input.press("Enter");
  await expect(words).not.toHaveText(before);
  // The collapse's own line may show first and the captain's wait its turn
  // behind it, so the captain's own line is the one this waits for.
  await expect(words).toContainText(said);
  await expect(dockSummaryLine(page, "activity")).toHaveAttribute("aria-description", /.+/);
  await expect(dockSummaryLine(page, "activity")).toHaveCount(1);
  await expect(activity.locator("[data-panel-summary-line-leaving]")).toHaveCount(0);

  // A newer line that replaces the focused line keeps focus on the line
  // (INF-1100): collapsing Tasks writes one, and its click moves no focus.
  await focusOn(dockSummaryLine(page, "activity"));
  await page.getByRole("button", { name: `Collapse ${dockTitle("now")}` }).dispatchEvent("click");
  await expect(words).not.toContainText(said);
  await untilFocused(dockSummaryLine(page, "activity"));

  // The line opens the panel from the keyboard, as the chevron does.
  await pressKey(dockSummaryLine(page, "activity"), "Enter");
  await expect(dockFrameElement(page, "activity")).toBeVisible();
  await expect(startedLine(page, key)).toBeVisible();
  await expect(title).toContainText(dockTitle("activity"));
});

test("settings is home-only territory for the rails, and the dock survives the trip", async () => {
  const { page } = launched;
  const key = await commissionFirstTask(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Settings",
  );
  expect(await page.locator("[data-rail]").count()).toBe(0);
  expect(await page.locator("[data-side-panel]").count()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Null state",
  );
  expect(await page.locator("[data-rail]").count()).toBe(2);
  // Back home, the panels still have something to show: the rail is open
  // at once, with the feed's lines painted again in a fresh mount.
  await expect(startedLine(page, key)).toBeVisible({ timeout: 10_000 });
  await expect(nowFrame(page).locator("[data-now-group]").first()).toBeVisible({ timeout: 10_000 });
});
