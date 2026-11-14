import { expect, test } from "@playwright/test";
import { UI_SIZES } from "../../src/shared/preferences";
import { scratchDir } from "../helpers/scratchDirs";
import { CORNERS, chooseSize, markCorners, readMarkers } from "./captureMarkers";
import { launchApp } from "./launch";
import { atRest, resizeWindow, settled } from "./layout";
import { regionShot } from "./pictures";
import { seedUsageLedger, usageTab } from "./usage";
import { focusOn, pressKey, runFromSearch } from "./windowKeys";

test("a whole-region picture waits for reveal and keeps every capture edge", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1200, height: 1000 });
    await runFromSearch(app, page, "settings.usage");
    const region = usageTab(page).section;
    await atRest(region);
    // Synthetic boundary fixture: the reproduced Usage crop was 1040×1023,
    // taller than Settings' scrollport. Markers test capture, not Usage's design.
    await region.evaluate((element) => {
      const target = element as HTMLElement;
      target.style.position = "relative";
      target.style.minHeight = "1023px";
      for (const [name, color, placement] of [
        ["top-left", "rgb(255,0,255)", "top:0;left:0"],
        ["top-right", "rgb(0,255,0)", "top:0;right:0"],
        ["bottom-right", "rgb(255,255,0)", "bottom:0;right:0"],
      ]) {
        const marker = document.createElement("div");
        marker.dataset.captureMarker = name;
        marker.style.cssText = `position:absolute;z-index:9999;width:6px;height:6px;background:${color};${placement}`;
        element.append(marker);
      }
    });
    await expect(regionShot(region)).rejects.toThrow(/Settings: bottom/);
    await resizeWindow(app, page, { width: 1200, height: 1400 });
    // A control can be interactive while its containing view is revealing.
    // The capture must await that motion, not just actionability or a sleep.
    await region.evaluate((element) => {
      element.parentElement?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 500,
        fill: "forwards",
      });
    });
    const bytes = await regionShot(region, test.info().outputPath("whole-region.png"));
    const counts = await region.evaluate(async (_element, png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Capture marker decoder missing");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const found = { left: 0, right: 0, bottom: 0 };
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i] ?? 0;
        const g = pixels[i + 1] ?? 0;
        const b = pixels[i + 2] ?? 0;
        if (r > 200 && g < 30 && b > 200) found.left++;
        if (r < 30 && g > 200 && b < 30) found.right++;
        if (r > 200 && g > 200 && b < 30) found.bottom++;
      }
      return found;
    }, bytes.toString("base64"));
    console.log("Whole-region capture markers:", counts);
    for (const [edge, count] of Object.entries(counts))
      expect(count, `the whole picture keeps its ${edge} edge after reveal`).toBeGreaterThanOrEqual(
        25,
      );
  } finally {
    await launched.close();
  }
});

// INF-4154: a picture of a section taken just after it opened was clipped by
// 1.9px. The opened section's reveal slides its content down into place with a
// transition Chromium lists among no animations, so the wait returned at once
// and the region was scrolled into view on a box the reveal still moved.
test("a region inside a section just opened waits for its reveal", async () => {
  // The Daily values section shows once the ledger holds usage.
  const userDataDir = scratchDir("infinitary-region-reveal-");
  seedUsageLedger(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1200, height: 1000 });
    await runFromSearch(app, page, "settings.usage");
    const daily = usageTab(page).section.locator("details[data-usage-daily-values]");
    const summary = daily.locator(":scope > summary");
    const region = daily.locator("thead");
    await focusOn(summary);
    await pressKey(summary, "Enter");
    await atRest(region);
    // Read at once: the box the wait let go of is the one the reveal leaves.
    const released = await region.boundingBox();
    expect(released).toEqual(await settled(page, () => region.boundingBox()));
    await regionShot(region, test.info().outputPath("opened-section.png"));
  } finally {
    await launched.close();
  }
});

test("a region picture holds the whole region it measured at every Size", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const region = page.locator("[data-prompt-dock]");
    for (const zoom of UI_SIZES) {
      await test.step(`${zoom}%`, async () => {
        await chooseSize(app, page, zoom);
        await resizeWindow(app, page, { width: 960, height: 640 });
        await markCorners(page, region);
        const picture = await regionShot(
          region,
          test.info().outputPath(`message-dock-${zoom}.png`),
        );
        const { counts, corners } = await readMarkers(page, picture);
        console.log(`${zoom}% corner markers: ${JSON.stringify({ counts, corners })}`);
        for (const [corner, count] of Object.entries(counts))
          expect(
            count,
            `the ${zoom}% picture keeps the region's ${corner} corner`,
          ).toBeGreaterThanOrEqual(25);
        // Cropped to the region itself: each corner of the picture is the region's own.
        expect(corners, `the ${zoom}% picture is cropped to the region`).toEqual(
          Object.fromEntries(Object.keys(CORNERS).map((corner) => [corner, corner])),
        );
      });
    }
  } finally {
    await launched.close();
  }
});
