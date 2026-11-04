import { expect, type Locator, type Page, test } from "@playwright/test";
import { ACTIONS } from "@shared/actions";
import { CONFIRM_RESET_PANELS } from "../../src/renderer/src/settings/panelsWords";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { savedArrangement } from "./panelLayout";
import { seedClockPanels } from "./personalFixtures";
import { feedLine } from "./rails";
import { focusOn, pressKey, runFromSearch } from "./windowKeys";

const cities = [
  { title: "Tokyo", zone: "Asia/Tokyo" },
  { title: "London", zone: "Europe/London" },
  { title: "Paris", zone: "Europe/Paris" },
];

/** The clocks a rail draws, top to bottom, by id. */
function clocksOn(page: Page, side: "left" | "right"): Promise<string[]> {
  return page
    .locator(`[data-rail="${side}"] [data-side-panel^="clock-"]`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-side-panel") ?? ""));
}

/** The saved layout's clocks in one slot, in order. */
async function savedClocks(page: Page, side: "left" | "right", y: "top" | "bottom") {
  return (await savedArrangement(page))[side][y].filter((id) => id.startsWith("clock-"));
}

function row(page: Page, id: string): Locator {
  return page.locator(`[data-panels-settings] [data-panels-row="${id}"]`);
}

/** Drags a panel's header by its title on the rails to `to`, in small steps a person's hand makes. */
async function dragHeader(
  page: Page,
  id: string,
  to: { x: number; y: number },
  before?: () => Promise<void>,
): Promise<void> {
  const header = page.locator(`[data-side-panel="${id}"] [data-panel-handle]`);
  const from = await header.boundingBox();
  if (!from) throw new Error(`${id} has no header on the rails`);
  const start = { x: from.x + 24, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++)
    await page.mouse.move(
      start.x + ((to.x - start.x) * step) / 12,
      start.y + ((to.y - start.y) * step) / 12,
    );
  await expect(page.locator("[data-panel-drag-ghost]")).toBeVisible();
  await before?.();
  await page.mouse.up();
}

/**
 * INF-2344, the captain: "Both: the tab, and arranging on the rails",
 * "make all panel headers draggable. there shouldn't be a toggle", the More
 * pick "saved in the layout where you can see it", and "change the tabs to
 * be a vertical column on the left". Data: the clock skill fixture with
 * three real cities, which dock on the left rail's top group, and the app's
 * own Activity. Completion: the saved arrangement read back through the
 * window's layout writer and the order the rails draw, after each key press
 * or drop. Platform: hermetic hidden Electron at the default size; nothing
 * Mac-only. Shared resources: none beyond the default serial desktop lane.
 */
test("panels arrange from Settings → Panels by keys and from their headers on the rails", async () => {
  const userDataDir = scratchDir("infinitary-panels-");
  seedClockPanels(userDataDir, cities);
  const launched: LaunchedApp = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page, app } = launched;
    await expect(page.locator('[data-side-panel^="clock-"]')).toHaveCount(cities.length, {
      timeout: 30_000,
    });
    expect(await savedClocks(page, "left", "top")).toEqual(["clock-0", "clock-1", "clock-2"]);

    await test.step("Arrange panels from command search opens Panels on its first row", async () => {
      await runFromSearch(app, page, "settings.panels");
      await expect(page.locator('[data-settings-tab="panels"]')).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(row(page, "clock-0")).toBeFocused();
    });

    await test.step("the Settings tabs run down a column on the left, stepped by ↓ and ↑", async () => {
      const tabs = page.locator('[role="tablist"][aria-orientation="vertical"]');
      const panels = tabs.locator('[data-settings-tab="panels"]');
      const keyboard = tabs.locator('[data-settings-tab="keyboard"]');
      const [above, below, section] = await Promise.all([
        panels.boundingBox(),
        keyboard.boundingBox(),
        page.locator('[role="tabpanel"]').boundingBox(),
      ]);
      if (!above || !below || !section) throw new Error("Settings drew no tabs");
      expect(below.y).toBeGreaterThanOrEqual(above.y + above.height);
      expect(below.x).toBe(above.x);
      expect(section.x).toBeGreaterThanOrEqual(above.x + above.width);
      await pressKey(panels, "ArrowDown");
      await expect(keyboard).toBeFocused();
      await expect(keyboard).toHaveAttribute("aria-selected", "true");
      await pressKey(keyboard, "ArrowUp");
      await expect(panels).toHaveAttribute("aria-selected", "true");
    });

    await test.step("⌥↓ and ⌥→ move a row in the saved layout, and focus stays on it", async () => {
      await pressKey(row(page, "clock-0"), "Alt+ArrowDown");
      await expect
        .poll(() => savedClocks(page, "left", "top"))
        .toEqual(["clock-1", "clock-0", "clock-2"]);
      await expect(row(page, "clock-0")).toBeFocused();
      await pressKey(row(page, "clock-0"), "Alt+ArrowRight");
      await expect.poll(() => savedClocks(page, "right", "top")).toEqual(["clock-0"]);
      await expect(
        page.locator('[data-panels-group="right:top"] [data-panels-row="clock-0"]'),
      ).toBeFocused();
    });

    await test.step("Space hides and shows a panel, Enter collapses it", async () => {
      await pressKey(row(page, "clock-0"), " ");
      await expect(row(page, "clock-0")).toHaveAttribute("data-panels-state", "hidden");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.settings.getLayout())).hiddenPanels,
        )
        .toEqual({ "clock-0": true });
      await pressKey(row(page, "clock-0"), " ");
      await expect(row(page, "clock-0")).toHaveAttribute("data-panels-state", "shown");
      await pressKey(row(page, "clock-0"), "Enter");
      await expect(row(page, "clock-0")).toHaveAttribute("data-panels-state", "collapsed");
    });

    await test.step("Reset to defaults asks once more, then puts every panel back on the rails and keeps the collapse", async () => {
      const reset = page.locator("[data-panels-reset]");
      await pressKey(reset, "Enter");
      await expect(reset).toHaveText(CONFIRM_RESET_PANELS);
      await pressKey(reset, "Enter");
      await expect
        .poll(() => savedClocks(page, "left", "top"))
        .toEqual(["clock-0", "clock-1", "clock-2"]);
      await expect(reset).toBeDisabled();
      await expect(row(page, "clock-0")).toHaveAttribute("data-panels-state", "collapsed");
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-screen-label="Settings"]')).toHaveCount(0);
      await expect.poll(() => clocksOn(page, "left")).toEqual(["clock-0", "clock-1", "clock-2"]);
      await expect.poll(() => clocksOn(page, "right")).toEqual([]);
      await expect(page.locator('[data-side-panel="clock-0"]')).toHaveAttribute(
        "data-side-panel-collapsed",
      );
    });

    await test.step("a header dragged above another panel lands there, with no mode to turn on", async () => {
      const target = await page.locator('[data-side-panel="clock-0"]').boundingBox();
      if (!target) throw new Error("Tokyo is not on the rails");
      await dragHeader(page, "clock-2", { x: target.x + target.width / 2, y: target.y + 4 });
      await expect
        .poll(() => savedClocks(page, "left", "top"))
        .toEqual(["clock-2", "clock-0", "clock-1"]);
      await expect.poll(() => clocksOn(page, "left")).toEqual(["clock-2", "clock-0", "clock-1"]);
      await expect(page.locator("[data-panel-drag-ghost]")).toHaveCount(0);
    });

    await test.step("Escape during a drag puts the panel back where it was", async () => {
      const target = await page.locator('[data-side-panel="clock-2"]').boundingBox();
      if (!target) throw new Error("Paris is not on the rails");
      await dragHeader(page, "clock-1", { x: target.x + target.width / 2, y: target.y + 4 }, () =>
        page.keyboard.press("Escape"),
      );
      await expect(page.locator("[data-panel-drag-ghost]")).toHaveCount(0);
      expect(await savedClocks(page, "left", "top")).toEqual(["clock-2", "clock-0", "clock-1"]);
    });

    await test.step("⌥↑ on a header's chevron moves the panel, keeps focus on it, and Activity names it", async () => {
      const chevron = page.locator('[data-side-panel="clock-1"] header button[aria-expanded]');
      await focusOn(chevron);
      await pressKey(chevron, "Alt+ArrowUp");
      await expect
        .poll(() => savedClocks(page, "left", "top"))
        .toEqual(["clock-2", "clock-1", "clock-0"]);
      await expect(
        page.locator('[data-side-panel="clock-1"] header button[aria-expanded]'),
      ).toBeFocused();
      // London and Tokyo traded places, which reads either way: the line
      // names the panel the captain moved.
      await expect(
        feedLine(
          page,
          ACTIONS.panel.done({
            surface: "London",
            description: "moved to the left rail, top, above Tokyo",
          }),
        ),
      ).toBeVisible();
    });
  } finally {
    await launched.close();
  }
});
