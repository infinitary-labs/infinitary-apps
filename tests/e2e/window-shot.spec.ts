import { existsSync } from "node:fs";
import { type CDPSession, expect, test } from "@playwright/test";
import { UI_SIZES } from "../../src/shared/preferences";
import { CORNERS, chooseSize, markCorners, readMarkers } from "./captureMarkers";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { REFUSED_PICTURE, windowShot } from "./pictures";

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
          expect(corners, `the ${zoom}% picture is the whole window`).toEqual(
            Object.fromEntries(Object.keys(CORNERS).map((corner) => [corner, corner])),
          );
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

/** Chromium's answer when every copy of the window comes back empty. */
const REFUSAL = "Protocol error (Page.captureScreenshot): Unable to capture screenshot";

/**
 * A picture Chromium refuses still fails, never tried again, and its error
 * names what the window showed just after, so a rare refusal explains itself
 * where it happens. Data: the app's own window at a fixed size, with the
 * refusal stood in at the protocol, since no window refuses on demand.
 * Completion signal: the picture's own rejection. It needs only a window,
 * so it runs wherever journeys run, and shares nothing with another test.
 */
test("a window picture Chromium refuses fails with what the window showed just after", async () => {
  const launched = await launchApp({ withMockProvider: true });
  const context = launched.page.context();
  const open = context.newCDPSession.bind(context);
  try {
    const { app, page } = launched;
    const size = { width: 960, height: 640 };
    await resizeWindow(app, page, size);
    // Stand-in for Chromium's rare refusal, at the protocol: the picture's own
    // session answers its first capture the way Chromium does when every copy
    // comes back empty, and passes every later call through unchanged.
    context.newCDPSession = async (target) => {
      context.newCDPSession = open;
      const session = await open(target);
      const send = session.send.bind(session) as (
        method: string,
        params?: object,
      ) => Promise<unknown>;
      let refused = false;
      session.send = ((method: string, params?: object) => {
        if (method !== "Page.captureScreenshot" || refused) return send(method, params);
        refused = true;
        return Promise.reject(new Error(REFUSAL));
      }) as CDPSession["send"];
      return session;
    };
    const path = test.info().outputPath("refused.png");
    const failure = await windowShot(page, path).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure, "the refused picture fails").toBeInstanceOf(Error);
    const { message, cause } = failure as Error;
    console.log(message);
    expect(existsSync(path), "a refused picture saves nothing").toBe(false);
    expect((cause as Error).message, "the error keeps Chromium's own refusal").toBe(REFUSAL);
    expect(message.split("\n")[0]).toMatch(
      new RegExp(`^${REFUSED_PICTURE.refused} after \\d+ ms: .*Unable to capture screenshot$`),
    );
    const shown = await page.evaluate(() => ({
      visibility: document.visibilityState,
      width: innerWidth,
      height: innerHeight,
    }));
    // What the window showed just after: each line holds the window's own reading.
    expect(message).toContain(`page: ${shown.visibility}, `);
    expect(message).toContain(`${shown.width} × ${shown.height} page pixels`);
    expect(message).toMatch(/window: (shown|hidden), (un)?focused, /);
    expect(message).toContain(`content ${size.width} × ${size.height}`);
    expect(message).toMatch(/processes: .*Browser started \d+ ms ago/);
    expect(message).toMatch(/processes: .*\(this page\) started \d+ ms ago/);
    expect(message).toContain(`drawing: ${REFUSED_PICTURE.drew} in `);
    // The window this journey keeps is healthy, so both copies asked after
    // the refusal work: the refusal was the stand-in's alone.
    expect(message).toContain(`${REFUSED_PICTURE.sameCopy}: ${REFUSED_PICTURE.works} in `);
    expect(message).toContain(
      `${REFUSED_PICTURE.freshCopy}, the whole page as a clip: ${REFUSED_PICTURE.works} in `,
    );
  } finally {
    context.newCDPSession = open;
    await launched.close();
  }
});
