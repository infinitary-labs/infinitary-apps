import { expect, type Page, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { windowShot } from "./pictures";

/**
 * The captain's pick on the Settings parity review (add-window-target): the
 * first mate changes a window's own setting at the Mac the captain names. A
 * second app controls the first mate's app here (docs/view.md, "What the
 * first mate asks of a window"); asked for that Mac by name, the first mate
 * changes that window's usage unit and key reminder, and leaves its own
 * computer's alone; asked with no computer named, it changes its own window's
 * key reminder and leaves the other's alone. Each change leaves one Activity
 * line naming the computer.
 */

const operations = async (page: Page) =>
  (await page.evaluate(() => window.infinitary.tasks.board())).tasks
    .filter((task) => task.kind === "operation")
    .map((task) => task.title);
const usageUnit = async (page: Page) =>
  (await page.evaluate(() => window.infinitary.settings.getAppearance())).usageUnit ?? "tokens";
const reminders = async (page: Page) =>
  (await page.evaluate(() => window.infinitary.keyboard.reminders())).on;

test("the first mate changes the named Mac's own usage unit and key reminder at its window, and its own at its own", async () => {
  test.setTimeout(180_000);
  const opened: LaunchedApp[] = [];
  try {
    const home = await launchApp({
      withMockProvider: true,
      env: { INFINITARY_DEVICE_NAME: "MacBook Pro" },
    });
    opened.push(home);
    const invite = await home.page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "mac" }),
    );
    const studio = await launchApp({ env: { INFINITARY_DEVICE_NAME: "Studio" } });
    opened.push(studio);
    // Joining starts the window over, so its answer may never return to this page.
    await studio.page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(studio.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
    );
    const ask = (change: Record<string, unknown>) =>
      askFirstmate(home.page, APP_CATALOG_PROMPT_MARKER + JSON.stringify(change));

    await test.step("the usage unit changes on Studio alone, with one line naming it", async () => {
      expect(await usageUnit(studio.page)).not.toBe("usd");
      const homeUnit = await usageUnit(home.page);
      const before = await operations(home.page);
      await ask({ action: "usage-unit", value: { unit: "usd" }, computer: "Studio" });
      await expect.poll(() => usageUnit(studio.page)).toBe("usd");
      expect(await usageUnit(home.page)).toBe(homeUnit);
      const line = `${ACTIONS["usage-unit"].done({ unit: "usd" })} on Studio`;
      await expect
        .poll(async () => (await operations(home.page)).filter((title) => !before.includes(title)))
        .toEqual([line]);
      await windowShot(studio.page, test.info().outputPath("evidence", "studio-usage-unit.png"));
    });

    await test.step("the key reminder turns off on Studio alone, then on this computer alone", async () => {
      expect(await reminders(studio.page)).toBe(true);
      expect(await reminders(home.page)).toBe(true);
      const before = await operations(home.page);
      await ask({ action: "key-reminders", value: { on: false }, computer: "Studio" });
      await expect.poll(() => reminders(studio.page)).toBe(false);
      expect(await reminders(home.page)).toBe(true);
      await ask({ action: "key-reminders", value: { on: false } });
      await expect.poll(() => reminders(home.page)).toBe(false);
      expect(await reminders(studio.page)).toBe(false);
      const done = ACTIONS["key-reminders"].done({ on: false });
      await expect
        .poll(async () => (await operations(home.page)).filter((title) => !before.includes(title)))
        .toEqual(expect.arrayContaining([`${done} on Studio`]));
      const added = (await operations(home.page)).filter((title) => !before.includes(title));
      expect(added).toHaveLength(2);
      expect(added.filter((title) => title.startsWith(done))).toHaveLength(2);
      await windowShot(home.page, test.info().outputPath("evidence", "home-activity.png"));
    });
  } finally {
    for (const app of opened.reverse()) await app.close();
  }
});
