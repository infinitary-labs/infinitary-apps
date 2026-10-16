import { expect, type Page, test } from "@playwright/test";
import type { UiSize } from "../../src/shared/preferences";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { PERSONALIZE_THEME_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";

/**
 * The still character follows the theme and the size (docs/renderer.md, the
 * character): under reduced motion the Firstmate is one still picture, and a
 * theme switch or a size change draws that same picture again - in the new
 * theme's colors, or at the new size's sharpness. The theme is driven
 * through the real Firstmate session and the mock provider: the captain asks
 * for light, and the Firstmate switches the theme mid-turn with the
 * character on screen - the switch that left the dark picture on a light
 * window (FI3-652). The size goes through the appearance row the size
 * shortcuts, menu and picker all write (tests/e2e/window-size.spec.ts owns
 * that they do): a zoom that left the old picture stretched (FI3-698).
 *
 * The pictures are compared with each other, never with a stored image or a
 * color: the switch changes the picture, nothing changes it again through
 * the rest of the turn, and switching back gives back the very picture the
 * character started with.
 */

declare global {
  interface Window {
    __fmBusyLog?: boolean[];
    __fmStill?: Promise<void>;
  }
}

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
});

function character(page: Page) {
  return page.getByRole("img", { name: /^First mate - / });
}

/** The character's canvas as it stands, read whole. */
function picture(page: Page): Promise<string> {
  return character(page).evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
}

function theme(page: Page): Promise<string> {
  return page.evaluate(() => document.body.dataset.theme ?? "");
}

/** Reduced motion on, then the one still frame it repaints: no sleep. */
async function holdStill(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__fmStill = new Promise<void>((resolve) => {
      const query = matchMedia("(prefers-reduced-motion: reduce)");
      // The motion loop schedules its still on the change event; two drawing
      // frames put this witness after that paint.
      const afterPaint = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      if (query.matches) afterPaint();
      else query.addEventListener("change", afterPaint, { once: true });
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.__fmStill);
}

/** The Firstmate's busy signal as the window hears it, in order. */
async function recordBusy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: boolean[] = [];
    window.__fmBusyLog = log;
    window.infinitary.events.on((event) => {
      if (event.type === "firstmate_state") log.push(event.busy);
    });
  });
}

const turnEnded = (page: Page) =>
  page.evaluate(() => {
    const log = window.__fmBusyLog ?? [];
    return log.includes(true) && log.at(-1) === false;
  });

test("under reduced motion a theme switch repaints the still Firstmate in the new colors", async () => {
  launched = await launchApp({ withMockProvider: true });
  const { page } = launched;
  await waitForFirstmateIdle(page);
  await holdStill(page);
  expect(await theme(page)).toBe("dark");
  const dark = await picture(page);
  await recordBusy(page);

  const input = promptInput(page);
  await input.click();
  await input.fill(PERSONALIZE_THEME_PROMPT_MARKER);
  await input.press("Enter");
  await expect.poll(() => theme(page), { timeout: 30_000 }).toBe("light");
  // The captain sees the character in the theme they asked for.
  await expect.poll(() => picture(page)).not.toBe(dark);
  const light = await picture(page);
  await page.screenshot({ path: test.info().outputPath("still-light.png") });

  // The repaint stepped nothing: the still holds through the rest of the
  // turn and after it, showing no state the turn passed through.
  await expect.poll(() => turnEnded(page), { timeout: 30_000 }).toBe(true);
  await waitForFirstmateIdle(page, 5_000);
  expect(await picture(page)).toBe(light);

  // Back to dark through the same preference push: the picture it started with.
  await page.evaluate(async () => {
    const { appearance } = await window.infinitary.settings.getPreferences();
    await window.infinitary.settings.setAppearance({ ...appearance, theme: "dark" });
  });
  await expect.poll(() => theme(page)).toBe("dark");
  await expect.poll(() => picture(page)).toBe(dark);
});

/** The size the core's appearance row holds, written as the size shortcuts write it. */
async function setSize(launched: LaunchedApp, size: UiSize): Promise<void> {
  await launched.page.evaluate(async (size) => {
    const { appearance } = await window.infinitary.settings.getPreferences();
    await window.infinitary.settings.setAppearance({ ...appearance, size });
  }, size);
  await expect
    .poll(() =>
      launched.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
      ),
    )
    .toBe(size / 100);
}

/** How far the canvas's pixels are from one per device pixel: 0 is sharp. */
function blur(page: Page): Promise<number> {
  return character(page).evaluate(
    (canvas) =>
      (canvas as HTMLCanvasElement).width -
      Math.round(canvas.getBoundingClientRect().width * devicePixelRatio),
  );
}

/** Whether the canvas holds a drawing, not the empty backing a refit leaves. */
function drawn(page: Page): Promise<boolean> {
  return character(page).evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const empty = document.createElement("canvas");
    empty.width = canvas.width;
    empty.height = canvas.height;
    return canvas.toDataURL() !== empty.toDataURL();
  });
}

test("under reduced motion a size change redraws the still Firstmate sharp", async () => {
  launched = await launchApp();
  const { page } = launched;
  await waitForFirstmateIdle(page);
  await holdStill(page);
  expect(await blur(page)).toBe(0);

  // Bigger: the same still, one canvas pixel per screen pixel again.
  await setSize(launched, 125);
  await expect.poll(() => blur(page)).toBe(0);
  expect(await drawn(page)).toBe(true);
  const bigger = await picture(page);

  // Smaller again, and sharp again.
  await setSize(launched, 100);
  await expect.poll(() => blur(page)).toBe(0);
  expect(await drawn(page)).toBe(true);

  // The redraws stepped nothing: bigger once more gives the very picture the
  // first visit drew, so no time passed and the machine held its state. (The
  // startup picture is no reference: after the first refit Chromium
  // anti-aliases a few hundred edge pixels of the same pose differently.)
  await setSize(launched, 125);
  await expect.poll(() => picture(page)).toBe(bigger);
  await waitForFirstmateIdle(page, 5_000);
});
