import { expect, type Locator, type Page } from "@playwright/test";
import * as m from "../../src/shared/i18n/messages.generated";

import { levelList } from "../../src/shared/levelWords";

/**
 * The Models board in Settings → Intelligence, as a person works it: a lane
 * per level and one for models not in use, each model a pill in every level
 * it is used at, and a panel that opens for the model whose name was
 * clicked. The one home of how a spec reaches into it, so a redesign of the
 * board is repaired here and not in every journey that places a model.
 */

export type Level = "premium" | "high" | "medium" | "low";

/** The Models section of Settings → Intelligence, which holds the board. */
export function modelsSection(page: Page): Locator {
  return page.getByRole("region", { name: "Models" });
}

/** The board itself, unfolded when it is folded, in Settings → Intelligence already open. */
export async function openModelsBoard(page: Page): Promise<Locator> {
  const models = modelsSection(page);
  await expect(models).toBeVisible();
  const head = models.getByRole("button", { name: /^Models/ });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return models;
}

/** A level's lane, or the Not in use lane. */
export function levelLane(models: Locator, level: Level | "off"): Locator {
  return models.locator(`[data-slot-group="${level}"]`);
}

/** A model's pill inside one lane, by offering key. */
export function modelPill(models: Locator, level: Level | "off", key: string): Locator {
  return levelLane(models, level).locator(`[data-model-row="${key}"]`);
}

/** A model's name inside one lane; `pinned` reads the ✱ a model set to always use carries. */
export function modelName(lane: Locator, label: string, pinned = false): Locator {
  return lane.getByRole("button", { name: pinned ? `${label} ✱` : label, exact: true });
}

/** Takes a model out of ONE level: the × on its pill there. */
export async function removeFromLevel(lane: Locator, label: string, level: Level) {
  await lane
    .getByRole("button", { name: `Remove ${label} from ${levelList([level])}`, exact: true })
    .click();
}

/** Opens the panel for a model by clicking its name in a lane; a second call finds it open. */
export async function openModelPanel(page: Page, lane: Locator, label: string): Promise<Locator> {
  const panel = page.getByRole("complementary", { name: `${label} levels`, exact: true });
  if ((await panel.count()) === 0) {
    await lane
      .getByRole("button", { name: new RegExp(`^${escapeRegExp(label)}( ✱)?$`) })
      .first()
      .click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeModelPanel(models: Locator) {
  const close = models.getByRole("complementary").getByRole("button", { name: /^Close / });
  if ((await close.count()) > 0) await close.click();
  await expect(models.getByRole("complementary")).toHaveCount(0);
}

export async function setLevelInPanel(panel: Locator, label: string, level: Level, on: boolean) {
  const box = panel.getByRole("checkbox", {
    name: `Use ${label} for ${levelList([level])}`,
    exact: true,
  });
  if ((await box.getAttribute("aria-checked")) !== String(on)) await box.click();
}

/** The switch that sends all crew work to the panel's model. */
export function alwaysUseSwitch(panel: Locator, label: string): Locator {
  return panel.getByRole("switch", {
    name: m.settingsLevelsAlwaysUseLabel({ model: label }),
    exact: true,
  });
}

export async function removeFromAllLevels(panel: Locator, label: string) {
  await panel.getByRole("button", { name: `Remove ${label} from all levels`, exact: true }).click();
}

/**
 * Drags a pill onto a lane with the mouse. `keepBoth` holds ⌥ at the drop,
 * and `whileOver` runs with the pill held over the lane, before the drop.
 */
export async function dragModel(
  page: Page,
  pill: Locator,
  lane: Locator,
  options: { keepBoth?: boolean; whileOver?: () => Promise<void> } = {},
) {
  await page.locator("[data-models-board]").scrollIntoViewIfNeeded();
  const from = await pill.getByRole("button").first().boundingBox();
  const to = await lane.boundingBox();
  if (!from || !to) throw new Error("The pill or the level it is dragged to has no box");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A press becomes a drag only once the pointer has travelled.
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 2 });
  if (options.keepBoth) await page.keyboard.down("Alt");
  await page.mouse.move(to.x + to.width - 24, to.y + to.height - 12, { steps: 6 });
  await options.whileOver?.();
  await page.mouse.up();
  if (options.keepBoth) await page.keyboard.up("Alt");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
