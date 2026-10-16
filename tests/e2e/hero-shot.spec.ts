import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { UI_SIZES } from "../../src/shared/preferences";
import { chooseSize, markCorners, readMarkers } from "./captureMarkers";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot } from "./pictures";

test("a hero pair holds the whole region it measured at every Size", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const region = page.locator("[data-prompt-dock]");
    const dir = test.info().outputPath("hero");
    for (const size of UI_SIZES) {
      await test.step(`${size}%`, async () => {
        await chooseSize(app, page, size);
        await resizeWindow(app, page, { width: 960, height: 640 });
        await markCorners(page, region);
        const pair = await heroShot(page, { region, name: `message-box-${size}`, dir });
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
    const pair = await heroShot(page, { region, name: "message-box-moving", dir });
    for (const file of [pair.dark, pair.light]) {
      const found = (await readMarkers(page, readFileSync(join(dir, file)), MOVING)).counts;
      console.log(`${file} moving marker: ${JSON.stringify(found)}`);
      expect(found.moving, `${file} holds the moving marker at rest`).toBeGreaterThanOrEqual(100);
    }
  } finally {
    await launched.close();
  }
});
