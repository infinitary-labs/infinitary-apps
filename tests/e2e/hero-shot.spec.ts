import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { UI_SIZES } from "../../src/shared/preferences";
import { chooseSize, markCorners, readMarkers } from "./captureMarkers";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot } from "./pictures";
import { activityFrame } from "./rails";

test("a hero pair holds the whole region at every Size while another hidden page exists", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    // INF-920: a task browser's newer hidden window must never receive the shell's theme push.
    await app.evaluate(({ BrowserWindow }) => {
      new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const region = page.locator("[data-prompt-dock]");
    const dir = test.info().outputPath("hero");
    for (const size of UI_SIZES) {
      await test.step(`${size}%`, async () => {
        await chooseSize(app, page, size);
        await resizeWindow(app, page, { width: 960, height: 640 });
        await markCorners(page, region);
        const pair = await heroShot(app, page, { region, name: `message-box-${size}`, dir });
        for (const file of [pair.dark, pair.light]) {
          const found = (await readMarkers(page, readFileSync(join(dir, file)))).counts;
          console.log(`${file} corner markers: ${JSON.stringify(found)}`);
          for (const [corner, count] of Object.entries(found))
            expect(count, `${file} keeps the region's ${corner} corner`).toBeGreaterThanOrEqual(25);
        }
      });
    }
  } finally {
    await launched.close();
  }
});

/** The moving marker's resting color, far from anything the app draws. */
const MOVING = { moving: [255, 0, 255] } as const;

test("a hero pair is taken while something in the window keeps moving", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    const region = page.locator("[data-prompt-dock]");
    await resizeWindow(app, page, { width: 960, height: 640 });
    const box = await region.boundingBox();
    if (!box) throw new Error("The region is not on screen");
    // Synthetic fixture: one marker in the middle of the region that pulses
    // without end, as the working dots do while the Firstmate works.
    await page.evaluate(
      ({ box, color: [red, green, blue] }) => {
        const style = document.createElement("style");
        style.textContent = "@keyframes capture-pulse { 50% { opacity: 0.25; } }";
        document.head.append(style);
        const marker = document.createElement("div");
        marker.dataset.captureMarker = "moving";
        marker.style.cssText = `position:fixed;z-index:9999;pointer-events:none;left:${box.x + box.width / 2 - 10}px;top:${box.y + box.height / 2 - 10}px;width:20px;height:20px;background:rgb(${red},${green},${blue});animation:capture-pulse 1.2s ease-in-out infinite`;
        document.body.append(marker);
      },
      { box, color: MOVING.moving },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter((motion) => motion.effect?.getComputedTiming().endTime === Infinity).length,
        ),
      )
      .toBeGreaterThan(0);
    const dir = test.info().outputPath("hero");
    const pair = await heroShot(app, page, { region, name: "message-box-moving", dir });
    for (const file of [pair.dark, pair.light]) {
      const found = (await readMarkers(page, readFileSync(join(dir, file)), MOVING)).counts;
      console.log(`${file} moving marker: ${JSON.stringify(found)}`);
      expect(found.moving, `${file} holds the moving marker at rest`).toBeGreaterThanOrEqual(100);
    }
  } finally {
    await launched.close();
  }
});

/** Activity's lines as the core keeps them, oldest first. */
async function activityLines(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.infinitary.feed.recent())).map((line) => line.text);
}

/** The titles of the operations on the record. */
async function operations(page: Page): Promise<string[]> {
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  return board.tasks.filter((task) => task.kind === "operation").map((task) => task.title);
}

// INF-752's report: a hero pair of the Activity dock came out mismatched,
// because the theme switch between the pictures wrote the captain's own
// "switched to the light theme" line into Activity for the light one only.
test("a hero pair of Activity shows the same lines in both themes, none of its own", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1100, height: 760 });
    // Activity holds the captain's own changes, as it does after a few in Settings.
    await chooseSize(app, page, 110);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await page.getByRole("switch", { name: "Crew model names" }).click();
    await page.keyboard.press("Escape");
    const region = page.locator('[data-side-panel="activity"]');
    const rows = activityFrame(page).locator("[data-feed-row]");
    await expect(rows).toHaveCount(2);
    const lines = await activityLines(page);
    const shown = await rows.allInnerTexts();
    const filed = await operations(page);
    const theme = (await page.evaluate(() => window.infinitary.settings.getAppearance())).theme;
    const seen: { lines: string[]; shown: string[] }[] = [];
    const dir = test.info().outputPath("hero");
    await heroShot(app, page, {
      region,
      name: "activity",
      dir,
      ready: async () => {
        seen.push({ lines: await activityLines(page), shown: await rows.allInnerTexts() });
      },
    });
    console.log(`Activity at each picture: ${JSON.stringify(seen)}`);
    expect(seen, "each picture shows Activity as it stood").toEqual([
      { lines, shown },
      { lines, shown },
    ]);
    expect(await activityLines(page)).toEqual(lines);
    expect(await operations(page), "the pictures file nothing on the record").toEqual(filed);
    // The saved theme never moved, and the window shows it again.
    expect((await page.evaluate(() => window.infinitary.settings.getAppearance())).theme).toBe(
      theme,
    );
    expect(await page.evaluate(() => document.body.dataset.theme)).toBe(theme);
  } finally {
    await launched.close();
  }
});
