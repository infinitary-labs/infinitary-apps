import { expect, test } from "@playwright/test";
import { UI_SIZES } from "../../src/shared/preferences";
import { CORNERS, chooseSize, markCorners, readMarkers } from "./captureMarkers";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { windowShot } from "./pictures";

test("a whole-window picture holds the whole window at every Size and leaves a recording whole", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    const size = { width: 960, height: 640 };
    // Synthetic boundary fixture: a box that is the window, for the markers,
    // and a dot that pulses without end, so the recording keeps getting frames.
    await page.evaluate(() => {
      const whole = document.createElement("div");
      whole.dataset.windowBox = "";
      whole.style.cssText = "position:fixed;inset:0;pointer-events:none";
      const dot = document.createElement("div");
      dot.style.cssText =
        "position:absolute;left:50%;top:50%;width:8px;height:8px;background:rgb(255,255,255)";
      dot.animate([{ opacity: 0.2 }, { opacity: 1 }], {
        duration: 300,
        iterations: Number.POSITIVE_INFINITY,
        direction: "alternate",
      });
      whole.append(dot);
      document.body.append(whole);
    });
    for (const zoom of UI_SIZES) {
      await test.step(`${zoom}%`, async () => {
        await chooseSize(app, page, zoom);
        await resizeWindow(app, page, size);
        await markCorners(page, page.locator("[data-window-box]"));
        // The recording a demo makes, running while the picture is taken.
        const frames: string[] = [];
        await page.screencast.start({
          size,
          onFrame: ({ viewportWidth, viewportHeight }) => {
            frames.push(`${viewportWidth} × ${viewportHeight}`);
          },
        });
        try {
          await expect.poll(() => frames.length).toBeGreaterThan(0);
          const before = frames.length;
          const picture = await windowShot(page, test.info().outputPath(`window-${zoom}.png`));
          // Frames the picture's capture drew arrive before the pulse's next ones.
          await expect.poll(() => frames.length).toBeGreaterThan(before + 2);
          const { counts, corners } = await readMarkers(page, picture);
          console.log(`${zoom}% corner markers: ${JSON.stringify({ counts, corners })}`);
          // Each corner of the picture is the window's own.
          expect(corners, `the ${zoom}% picture is the whole window`).toEqual(
            Object.fromEntries(Object.keys(CORNERS).map((corner) => [corner, corner])),
          );
          // Every frame recorded around the picture is the whole window too.
          expect(
            new Set(frames),
            `the ${zoom}% recording keeps the whole window while the picture is taken`,
          ).toEqual(new Set([frames[0]]));
        } finally {
          await page.screencast.stop();
        }
      });
    }
  } finally {
    await launched.close();
  }
});
