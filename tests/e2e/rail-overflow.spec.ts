import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { PanelMountState } from "@shared/personal/mounts";
import { surfaceWord } from "../../src/core/personal/panelMounts";
import { scratchDir } from "../helpers/scratchDirs";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { expectClearOf, resizeWindow } from "./layout";
import { promptInput } from "./prompt";
import { latestContext } from "./providerRequest";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

const cities = [
  { title: "Tokyo", zone: "Asia/Tokyo" },
  { title: "London", zone: "Europe/London" },
  { title: "Paris", zone: "Europe/Paris" },
  { title: "Sydney", zone: "Australia/Sydney" },
  { title: "New York", zone: "America/New_York" },
];

/** The five clocks under the personal folder, four anchored at the top and New York at the foot. */
function writeClocks(userDataDir: string): void {
  const workspace = join(userDataDir, "fleet", "personal");
  for (const [index, city] of cities.entries()) {
    const dir = join(workspace, `clock-${index}`);
    mkdirSync(dir, { recursive: true });
    cpSync("tests/fixtures/personal-skills/tokyo-clock/panel.tsx", join(dir, "panel.tsx"));
    writeFileSync(
      join(dir, "panel.tsx"),
      readFileSync(join(dir, "panel.tsx"), "utf8").replace("Asia/Tokyo", city.zone),
    );
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        title: city.title,
        placement: { x: "left", y: index === 4 ? "bottom" : "top" },
        order: index,
        presence: { always: true },
      }),
    );
  }
}

/**
 * INF-609, accepted direction B and write-move: five genuine personal clock
 * fixtures dock, fold, remain reachable by keys through More, and restore.
 * Data: the existing clock skill fixture with five real cities/time zones.
 * Completion: body/header reachability, the More count, saved order after a
 * relaunch and a taller window showing every body. Platform: hermetic hidden
 * Electron with resizable content, no external account or native focus.
 * Shared resources: none beyond the default serial desktop lane.
 */
test("crowded rails fold, own expand pins, and a More pick survives relaunch on either rail", async () => {
  const userDataDir = scratchDir("infinitary-rail-room-");
  writeClocks(userDataDir);
  let launched: LaunchedApp = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page, app } = launched;
    await expect(page.locator('[data-side-panel^="clock-"]')).toHaveCount(cities.length, {
      timeout: 30_000,
    });
    await page.evaluate(() =>
      window.infinitary.settings.setLayout({
        collapsedPanels: {},
        hiddenPanels: { activity: true, now: true },
        placements: {},
      }),
    );
    // The five-panel rule needs a window below the desktop's normal minimum.
    // Only this disposable window changes its minimum; production is untouched.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setMinimumSize(0, 0);
    });
    await resizeWindow(app, page, { width: 1280, height: 500 });
    const sydney = page.locator('[data-side-panel="clock-3"]');
    await expect(sydney.locator("[data-side-panel-body]")).toBeHidden();
    await pressKey(sydney.getByRole("button", { name: /Expand/ }), "Enter");
    await expect(sydney.locator("[data-side-panel-body]")).toBeVisible();
    const pinned = await page.evaluate(() => window.infinitary.settings.getLayout());
    expect(pinned.collapsedPanels["clock-3"]).toBe(false);
    await resizeWindow(app, page, { width: 1280, height: 320 });
    const more = page.locator('[data-rail="left"] [data-rail-more]');
    await expect(more).toBeVisible();
    const hiddenIds = await page
      .locator('[data-side-panel^="clock-"][hidden]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-side-panel")));
    expect(hiddenIds.length).toBeGreaterThanOrEqual(2);
    await expect(more.getByRole("button")).toContainText(String(hiddenIds.length));
    await focusOn(more.getByRole("button"));
    await pressWindowKey(app, "F6");
    await expect(promptInput(page)).toBeFocused();
    await pressWindowKey(app, "F6", ["shift"]);
    await expect(more.getByRole("button")).toBeFocused();
    await pressKey(more.getByRole("button"), "Enter");
    await pressKey(page.getByRole("menu").getByRole("menuitem").first(), "ArrowDown");
    await expect(page.getByRole("menu").getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(more.getByRole("button")).toBeFocused();
    const beforePick = await page.evaluate(() => window.infinitary.settings.getLayout());
    expect(beforePick).toEqual(pinned); // Room never writes personal collapse/hide.
    await pressKey(more.getByRole("button"), "Enter");
    const menu = page.getByRole("menu");
    await expectClearOf(page, menu);
    await expect(menu.getByRole("menuitem")).toHaveCount(hiddenIds.length);
    const chosen = hiddenIds[0];
    if (!chosen) throw new Error("No hidden clock to choose");
    const chosenIndex = Number(chosen.slice("clock-".length));
    const city = cities[chosenIndex];
    if (!city) throw new Error("Unknown fixture clock");
    await pressKey(menu.getByRole("menuitem", { name: city.title, exact: true }), "Enter");
    await expect(page.locator(`[data-side-panel="${chosen}"]`)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.settings.getLayout())).panelOrder?.[0],
      )
      .toBe(chosen);
    await launched.close();
    launched = await launchApp({ userDataDir, withMockProvider: true });
    const restarted = launched.page;
    expect(
      (await restarted.evaluate(() => window.infinitary.settings.getLayout())).panelOrder?.[0],
    ).toBe(chosen);
    await resizeWindow(launched.app, restarted, { width: 1280, height: 1000 });
    await expect(restarted.locator("[data-rail-more]")).toHaveCount(0);
    for (const index of cities.keys())
      await expect(
        restarted.locator(`[data-side-panel="clock-${index}"] [data-side-panel-body]`),
      ).toBeVisible();
    // Move the same panels to the opposite rail through its real layout owner.
    await restarted.evaluate(async () => {
      const layout = await window.infinitary.settings.getLayout();
      await window.infinitary.settings.setLayout({
        ...layout,
        placements: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            `clock-${index}`,
            { x: "right", y: index === 4 ? "bottom" : "top" },
          ]),
        ),
      });
    });
    await launched.app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setMinimumSize(0, 0);
    });
    await resizeWindow(launched.app, restarted, { width: 1280, height: 320 });
    await expect(restarted.locator('[data-rail="right"] [data-rail-more]')).toBeVisible();
    await resizeWindow(launched.app, restarted, { width: 1280, height: 1000 });
    for (const index of cities.keys())
      await expect(
        restarted.locator(
          `[data-rail="right"] [data-side-panel="clock-${index}"] [data-side-panel-body]`,
        ),
      ).toBeVisible();
  } finally {
    await launched.close();
  }
});

/**
 * INF-711: the first mate's surfaces list says which panels a short rail
 * folded to their headers and which it gathered into its More row, read
 * from the window's own measure, so it never calls a panel drawn whose body
 * is out of sight. Data: the same five clock fixtures. Completion: the
 * first mate's next turn carries the window's answer for each clock, set
 * against what the rail draws at that moment. Platform: hermetic hidden
 * Electron with resizable content and the mock provider. Shared resources:
 * none beyond the default serial desktop lane.
 */
test("the first mate hears which panels a short rail folded for room and which it gathered into More", async () => {
  const userDataDir = scratchDir("infinitary-rail-room-said-");
  writeClocks(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page, app, mockProvider } = launched;
    if (!mockProvider) throw new Error("The journey needs the mock provider");
    await expect(page.locator('[data-side-panel^="clock-"]')).toHaveCount(cities.length, {
      timeout: 30_000,
    });
    await page.evaluate(() =>
      window.infinitary.settings.setLayout({
        collapsedPanels: {},
        hiddenPanels: { activity: true, now: true },
        placements: {},
      }),
    );
    // As in the journey above, only this disposable window drops its minimum.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setMinimumSize(0, 0);
    });
    await resizeWindow(app, page, { width: 1280, height: 320 });
    await expect(page.locator('[data-rail="left"] [data-rail-more]')).toBeVisible();
    // What the rail draws now: gathered into More (its chrome hidden), folded
    // to its header, or drawn, read off the rail's own marks.
    const drawnAs = async () =>
      Object.fromEntries(
        await page
          .locator('[data-side-panel^="clock-"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => [
              node.getAttribute("data-side-panel") ?? "",
              (node as HTMLElement).hidden
                ? "gathered"
                : node.hasAttribute("data-side-panel-folded")
                  ? "folded"
                  : "drawn",
            ]),
          ),
      ) as Record<string, PanelMountState>;
    const onRail = await drawnAs();
    expect(Object.values(onRail)).toContain("gathered");
    expect(Object.values(onRail)).toContain("folded");

    const before = mockProvider.requestBodies().length;
    await askFirstmate(page, "Where are my clocks?");
    const context = latestContext(mockProvider.requestBodies()[before] ?? "") as
      | { surfaces?: { panels?: { id: string; state: string }[] } }
      | undefined;
    const said = Object.fromEntries(
      (context?.surfaces?.panels ?? [])
        .filter((panel) => panel.id.startsWith("clock-"))
        .map((panel) => [panel.id, panel.state]),
    );
    // The rail drew the same while the first mate was asked.
    expect(await drawnAs()).toEqual(onRail);
    expect(said).toEqual(
      Object.fromEntries(
        Object.entries(onRail).map(([id, state]) => [
          id,
          surfaceWord({ id, kind: "personal", version: null, state, rail: "left", why: null }),
        ]),
      ),
    );
  } finally {
    await launched.close();
  }
});
