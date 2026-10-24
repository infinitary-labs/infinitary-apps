import { expect, type Locator, type Page, test } from "@playwright/test";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { minimumWindowSize, overflows, type Rect, resizeWindow, settled, within } from "./layout";

import { promptInput } from "./prompt";
import { expandDock } from "./rails";
import { CARD_WIDTH_PROMPT_MARKER, cardWidths, WIDTH_CARD_TITLES } from "./scenarios/cardWidths";
import { pager, showCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * Real crewmate emits through the mock provider and the host's width rule:
 * wide content stays reachable whole, a card that folds the docks gives them
 * back on the edge tab, and the captain's drag resizes a card and holds.
 * The widths themselves are `cardGeometry.test.ts`'s.
 */

let launched: LaunchedApp;

const layer = (page: Page) => page.locator("[data-card-layer]");

async function boxOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box`);
  return box;
}

/** The shown card's box once its move has settled. */
const cardBox = (page: Page) => settled(page, () => boxOf(layer(page)));

/** The shown card's width once its move has settled. */
async function expectCardWidth(page: Page, width: number) {
  await expect.poll(async () => (await boxOf(layer(page))).width).toBeCloseTo(width, 0);
}

const body = (page: Page, title: string) => cardBody(page, title);

test.beforeAll(async () => {
  launched = await launchApp({ scenarios: [cardWidths], withMockProvider: true });
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`commission a crewmate: ${CARD_WIDTH_PROMPT_MARKER}`);
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

  // A card that asks for the whole stage folds the docks; the edge tab
  // brings them back.
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

test("the captain's drag resizes a card and holds while it is up", async () => {
  const { page } = launched;
  await showCard(page, WIDTH_CARD_TITLES.regular);
  const regular = (await cardBox(page)).width;
  await showCard(page, WIDTH_CARD_TITLES.wide);
  const decided = (await cardBox(page)).width;
  const edge = page.locator('[data-card-edge="right"]');
  await expect(edge).toHaveAttribute("aria-valuenow", String(Math.round(decided)));
  const box = await boxOf(edge);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Far enough inward on one edge to take the card under regular, so the
  // docks the wide card folded come back.
  const inward = Math.ceil((decided - regular) / 2) + 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - inward / 2, y, { steps: 4 });
  await page.mouse.move(x - inward, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await cardBox(page)).width).toBeLessThan(decided);
  const dragged = (await cardBox(page)).width;

  // Paged away and back, the drag holds.
  await showCard(page, WIDTH_CARD_TITLES.regular);
  await expectCardWidth(page, regular);
  await showCard(page, WIDTH_CARD_TITLES.wide);
  await expectCardWidth(page, dragged);

  // The keyboard also widens the card.
  await pressKey(page.locator('[data-card-edge="right"]'), "ArrowRight");
  await expect.poll(async () => (await cardBox(page)).width).toBeGreaterThan(dragged);

  // A double click gives the card back the width the host decided.
  await page.locator('[data-card-edge="left"]').dblclick();
  await expectCardWidth(page, decided);
  await expect(page.locator('[data-rail-tab="left"]')).toBeVisible();
});
