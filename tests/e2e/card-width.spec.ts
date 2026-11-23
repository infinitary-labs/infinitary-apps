import { expect, type Locator, type Page, test } from "@playwright/test";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { minimumWindowSize, overflows, type Rect, resizeWindow, settled, within } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock } from "./rails";
import { CARD_WIDTH_PROMPT_MARKER, cardWidths, WIDTH_CARD_TITLES } from "./scenarios/cardWidths";
import { pager, showCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * Real crewmate emits through the mock provider and the host's width rule:
 * wide content stays reachable whole, and a card that folds the docks gives
 * them back on the edge tab, with the Tasks dock's own frame putting it on
 * its rail. The captain's drag is `tests/browser/card-width.test.tsx`'s; the
 * widths themselves are `cardGeometry.test.ts`'s.
 */

let launched: LaunchedApp;

async function boxOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box`);
  return box;
}

const body = (page: Page, title: string) => cardBody(page, title);

test.beforeAll(async () => {
  launched = await launchApp({ scenarios: [cardWidths], withMockProvider: true });
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${CARD_WIDTH_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
  await expandDock(page, "activity");
  await expandDock(page, "now");
});

test.afterAll(async () => {
  await launched.close();
});

test("a wide card's table is reachable whole at the smallest window, and the rail tab gives the docks back", async () => {
  const { app, page } = launched;
  const original = await resizeWindow(app, page, await minimumWindowSize(app));
  try {
    await showCard(page, WIDTH_CARD_TITLES.wide);
    const frame = body(page, WIDTH_CARD_TITLES.wide);
    const table = frame.getByRole("table");
    await expect(table).toBeVisible();
    // No column of it is cut off: it lies inside the card's body, which has
    // no sideways scroll to hide a part behind.
    const boxes = await settled(page, async () => ({
      table: await boxOf(table),
      body: await boxOf(cardBodyElement(page, WIDTH_CARD_TITLES.wide)),
    }));
    expect(within(boxes.table, boxes.body)).toEqual([]);
    expect(await overflows(frame.locator(":root"))).toBe(0);
    // Returning to regular still cannot fit beside the docks here. Do not
    // offer an edge action that leaves the panels folded (FI3-530).
    await expect(page.locator("[data-rail-tab]")).toHaveCount(0);
    await showCard(page, WIDTH_CARD_TITLES.regular);
    await expect(page.locator("[data-rail-tab]")).toHaveCount(0);
  } finally {
    await resizeWindow(app, page, original);
  }

  await showCard(page, WIDTH_CARD_TITLES.full);
  await expect(page.locator('[data-rail-tab="left"]')).toBeVisible();
  await page.locator('[data-rail-tab="left"]').click();

  await expect(page.locator('[data-rail="left"]')).toBeVisible();
  await expect(page.locator('[data-rail="right"]')).toBeVisible();

  // Returning to the host width folds again. The other tab restores the
  // same panels, reached and activated by keyboard rather than pointer.
  await page.locator('[data-card-edge="left"]').dblclick();
  const leftTab = page.locator('[data-rail-tab="left"]');
  const rightTab = page.locator('[data-rail-tab="right"]');
  await expect(leftTab).toBeVisible();
  await pressKey(leftTab, "Tab");
  await expect(rightTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-rail="left"]')).toBeVisible();
  await expect(page.locator('[data-rail="right"]')).toBeVisible();
});
