import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { readPicture } from "../../src/core/pictureFormat";
import { MAX_HERO_BYTES, MAX_HERO_WIDTH, PICTURES_DIR } from "../../src/core/releaseNotes/catalog";
import type { PushChannel } from "../../src/shared/ipc";
import type { ShellPreferences, Theme } from "../../src/shared/preferences";
import { atRest, within } from "./layout";

/**
 * A whole region, after its reveal, wholly inside the window and every
 * clipping ancestor. Callers choose the window size or a smaller region;
 * an oversized locator screenshot cannot recover a scroller's hidden content.
 */
export async function readyRegion(region: Locator): Promise<void> {
  await atRest(region);
  await region.scrollIntoViewIfNeeded();
  await atRest(region);
  const geometry = await region.evaluate((element) => {
    const box = element.getBoundingClientRect().toJSON();
    const clips = [{ name: "window", x: 0, y: 0, width: innerWidth, height: innerHeight }];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      const clipsX = style.overflowX !== "visible";
      const clipsY = style.overflowY !== "visible";
      if (clipsX || clipsY)
        clips.push({
          name: parent.getAttribute("data-screen-label") ?? parent.tagName,
          x: clipsX ? rect.x + parent.clientLeft : box.x,
          y: clipsY ? rect.y + parent.clientTop : box.y,
          width: clipsX ? parent.clientWidth : box.width,
          height: clipsY ? parent.clientHeight : box.height,
        });
    }
    return { box, clips };
  });
  const escaped = geometry.clips.flatMap((clip) =>
    within(geometry.box, clip).map((edge) => `${clip.name}: ${edge}`),
  );
  if (escaped.length)
    throw new Error(
      `Whole-region picture would be clipped (${escaped.join(", ")}). Resize the window or choose a smaller region.`,
    );
}

/**
 * Photograph a prepared region at any Size, cropped to the window pixels it
 * covers, with the caret hidden (`clipShot`); motion keeps playing.
 */
export async function regionShot(region: Locator, path?: string): Promise<Buffer> {
  await readyRegion(region);
  const box = await region.boundingBox();
  if (!box?.width || !box.height) throw new Error("The region is not on screen or has no size");
  return saved(await clipShot(region.page(), box, "allow"), path);
}

/**
 * Photograph the whole window at any Size, at the window's own resolution,
 * with the caret hidden (`drawnWindow`); motion keeps playing. Playwright's
 * own `page.screenshot` hands Chromium the page's size in page pixels, which
 * Chromium reads as the window's unzoomed pixels, so once a Size zooms the
 * window it shows only the window's top-left.
 */
export async function windowShot(page: Page, path?: string): Promise<Buffer> {
  return saved(await drawnWindow(page, "allow"), path);
}

/** The picture, written to `path` first when there is one. */
function saved(png: Buffer, path?: string): Buffer {
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png);
  }
  return png;
}

/**
 * A change's hero pictures (docs/release-notes.md "Who writes what",
 * docs/testing.md "A hero picture"): the crop of one After view that a
 * startup note shows when the change is a highlight, in both themes, written
 * beside the notes as `<name>-dark.webp` and `<name>-light.webp`.
 *
 * The crop is the component that holds the new thing plus the anchors that
 * say where it is, padded out to a landscape between 16 by 9 and 2 by 1
 * inside the window; both themes come from that one clip in one run, so the
 * pair matches to the pixel, at whatever Size the window is at. The theme is
 * only shown, never saved (`themed`), so neither picture holds a line the
 * switch wrote. Nothing is drawn on the pictures. Encoding is the app's own
 * Chromium (a canvas), so no dependency is added.
 */

export type HeroShot = {
  /** The component that holds the new thing: the card, the panel, the row. */
  region: Locator;
  /** What says where it is: the panel's title, the row beside it, the character's line. */
  anchors?: Locator[];
  /** The note entry's id, which names the pair. */
  name: string;
  /** Where the pair goes: the repository's release-notes/pictures by default. */
  dir?: string;
  /**
   * Brings the view back before each theme's picture, when switching the
   * theme lets go of it (a pointer resting on a row).
   */
  ready?: () => Promise<void>;
};

export type HeroPair = { dark: string; light: string; width: number; height: number };

type Box = { x: number; y: number; width: number; height: number };

/** Room around the union, so a border at its edge is kept whole. */
const MARGIN = 12;
const NARROWEST = 16 / 9;
const WIDEST = 2;

/** The union of the region and its anchors, with a margin, grown to landscape inside the window. */
export function heroClip(boxes: Box[], window: { width: number; height: number }): Box {
  const left = Math.min(...boxes.map((box) => box.x)) - MARGIN;
  const top = Math.min(...boxes.map((box) => box.y)) - MARGIN;
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + MARGIN;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + MARGIN;
  let width = right - left;
  let height = bottom - top;
  if (width / height < NARROWEST) width = height * NARROWEST;
  if (width / height > WIDEST) height = width / WIDEST;
  width = Math.min(width, window.width);
  height = Math.min(height, window.height);
  if (width < height)
    throw new Error(
      `The hero crop is ${Math.round(width)} by ${Math.round(height)}: crop to a smaller component or widen the window.`,
    );
  // Centered on the union, then kept inside the window.
  const x = Math.min(Math.max(0, (left + right) / 2 - width / 2), window.width - width);
  const y = Math.min(Math.max(0, (top + bottom) / 2 - height / 2), window.height - height);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Shows the window in one theme, or with none in the captain's saved one, and
 * waits until the window and every card body show it at rest.
 *
 * Nothing is saved: the window gets the captain's saved preferences with the
 * theme in place, as the core pushes them after a change, and the window
 * material follows as the main process keeps it (src/main/app.ts). Switching
 * through Settings is the captain's own change, which writes its line in
 * Activity (docs/orchestrator-contract.md, "Settled runs"): a picture of
 * Activity, or of its newest line on a collapsed panel, would hold it in one
 * theme and not the other.
 */
async function themed(app: ElectronApplication, page: Page, theme?: Theme): Promise<void> {
  const saved = await page.evaluate(() => window.infinitary.settings.getPreferences());
  const shown: ShellPreferences = theme
    ? { ...saved, appearance: { ...saved.appearance, theme } }
    : saved;
  const channel: PushChannel = "inf:shell:preferences";
  await app.evaluate(
    ({ BrowserWindow, nativeTheme }, { channel, shown }) => {
      // The app's own window is its first, as every journey's window helper reads it.
      const appWindow = BrowserWindow.getAllWindows()[0];
      if (!appWindow) throw new Error("No window to show the theme in");
      nativeTheme.themeSource = shown.appearance.theme;
      appWindow.webContents.send(channel, shown);
    },
    { channel, shown },
  );
  const next = shown.appearance.theme;
  await expect.poll(() => page.evaluate(() => document.body.dataset.theme)).toBe(next);
  await expect
    .poll(async () => {
      const themes = await Promise.all(
        page
          .frames()
          .filter((frame) => frame !== page.mainFrame())
          .map((frame) =>
            frame.evaluate(() => document.documentElement.dataset.theme ?? "").catch(() => ""),
          ),
      );
      return themes.every((value) => value === "" || value === next);
    })
    .toBe(true);
  // A transition the theme change cut short is at rest too: its `finished`
  // rejects. Motion that never ends, such as the working dots, is not waited
  // for, as `atRest` does not; the picture holds it at its start.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((motion) => motion.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY)
        .map((motion) => motion.finished.catch(() => undefined)),
    ),
  );
}

/** A PNG screenshot as WebP, no wider than the cap, at the first quality that fits under it. */
async function toWebp(page: Page, png: Buffer): Promise<Buffer> {
  for (const quality of [0.86, 0.78, 0.68, 0.56]) {
    const base64 = await page.evaluate(
      async ({ data, quality, maxWidth }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const scale = Math.min(1, maxWidth / bitmap.width);
        const canvas = new OffscreenCanvas(
          Math.round(bitmap.width * scale),
          Math.round(bitmap.height * scale),
        );
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No canvas to encode the hero picture");
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality });
        const out = new Uint8Array(await blob.arrayBuffer());
        let text = "";
        for (let at = 0; at < out.length; at += 0x8000)
          text += String.fromCharCode(...out.subarray(at, at + 0x8000));
        return btoa(text);
      },
      { data: png.toString("base64"), quality, maxWidth: MAX_HERO_WIDTH },
    );
    const webp = Buffer.from(base64, "base64");
    if (webp.length <= MAX_HERO_BYTES) return webp;
  }
  throw new Error("The hero picture stays over 300 KB: crop to a smaller component.");
}

type StillWindow = Window & { __heroRelease?: () => void };

/**
 * Holds every frame still for one picture, until the returned release puts
 * it back: carets turn transparent, as Playwright's `caret: "hide"` does, and
 * with `motion` finite motion jumps to its end and endless motion stops at
 * its start, as `animations: "disabled"` does.
 */
async function holdStill(page: Page, motion: boolean): Promise<() => Promise<void>> {
  const frames = page.frames();
  await Promise.all(
    frames.map((frame) =>
      frame
        .evaluate(async (motion) => {
          const carets = [
            ...document.querySelectorAll<HTMLElement>("input,textarea,[contenteditable]"),
          ].map((element) => {
            const value = element.style.getPropertyValue("caret-color");
            const priority = element.style.getPropertyPriority("caret-color");
            element.style.setProperty("caret-color", "transparent", "important");
            return () => element.style.setProperty("caret-color", value, priority);
          });
          const endless = new Set<Animation>();
          const still = () => {
            for (const motion of document.getAnimations()) {
              if (!motion.effect || motion.playbackRate === 0 || endless.has(motion)) continue;
              if (Number.isFinite(motion.effect.getComputedTiming().endTime)) motion.finish();
              else {
                motion.cancel();
                endless.add(motion);
              }
            }
          };
          if (motion) {
            still();
            document.addEventListener("transitionrun", still);
            document.addEventListener("animationstart", still);
          }
          (window as StillWindow).__heroRelease = () => {
            document.removeEventListener("transitionrun", still);
            document.removeEventListener("animationstart", still);
            for (const put of carets) put();
            for (const motion of endless) motion.play();
          };
          await document.fonts.ready;
        }, motion)
        .catch(() => undefined),
    ),
  );
  return async () => {
    await Promise.all(
      frames.map((frame) =>
        frame
          .evaluate(() => {
            (window as StillWindow).__heroRelease?.();
            delete (window as StillWindow).__heroRelease;
          })
          .catch(() => undefined),
      ),
    );
  };
}

/**
 * A PNG of the whole window as Chromium has drawn it, at the window's own
 * resolution at any Size, taken while `holdStill` holds the caret, and with
 * `"still"` motion too. It hands Chromium no clip: any clip briefly crops
 * Chromium's drawing surface, which a recording running alongside catches,
 * and Playwright's own screenshot always hands one, in page pixels where
 * Chromium reads window pixels.
 */
async function drawnWindow(page: Page, motion: "still" | "allow"): Promise<Buffer> {
  const session = await page.context().newCDPSession(page);
  try {
    const release = await holdStill(page, motion === "still");
    try {
      const { data } = await session.send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    } finally {
      await release();
    }
  } finally {
    await session.detach();
  }
}

/**
 * A PNG of one clip of the window, given in page pixels, at any Size.
 * Playwright's own screenshot hands Chromium page pixels where Chromium reads
 * window pixels, and trims the clip at the page's width first, so once a Size
 * zooms the window its clip lands up and to the left of the region and is cut
 * short. This crops the whole window as drawn (`drawnWindow`) in the app's own
 * canvas, to every window pixel the clip touches, so the picture is the region
 * at the window's own resolution and nothing else sees the capture.
 */
async function clipShot(page: Page, clip: Box, motion: "still" | "allow"): Promise<Buffer> {
  const drawn = (await drawnWindow(page, motion)).toString("base64");
  const base64 = await page.evaluate(
    async ({ data, clip }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const whole = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      // Picture pixels per page pixel: the Size's zoom times the screen's
      // scale, which Chromium reports together as the device pixel ratio.
      const scale = devicePixelRatio;
      // Every window pixel the clip touches; a hair's tolerance keeps an
      // edge that lands on a pixel boundary by rounding from taking one more.
      const left = Math.max(0, Math.floor(clip.x * scale + 1e-3));
      const top = Math.max(0, Math.floor(clip.y * scale + 1e-3));
      const right = Math.min(whole.width, Math.ceil((clip.x + clip.width) * scale - 1e-3));
      const bottom = Math.min(whole.height, Math.ceil((clip.y + clip.height) * scale - 1e-3));
      const canvas = new OffscreenCanvas(right - left, bottom - top);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas to crop the picture");
      context.drawImage(
        whole,
        left,
        top,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const out = new Uint8Array(
        await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
      );
      let text = "";
      for (let at = 0; at < out.length; at += 0x8000)
        text += String.fromCharCode(...out.subarray(at, at + 0x8000));
      return btoa(text);
    },
    { data: drawn, clip },
  );
  return Buffer.from(base64, "base64");
}

/** Photographs one clip in both themes and writes the pair; the saved theme shows again after. */
export async function heroShot(
  app: ElectronApplication,
  page: Page,
  shot: HeroShot,
): Promise<HeroPair> {
  const dir = shot.dir ?? PICTURES_DIR;
  mkdirSync(dir, { recursive: true });
  let clip: Box | undefined;
  const pair: Partial<HeroPair> = {};
  let size = { width: 0, height: 0 };
  try {
    for (const theme of ["dark", "light"] as const) {
      await themed(app, page, theme);
      await shot.ready?.();
      if (!clip) {
        const boxes = await Promise.all(
          [shot.region, ...(shot.anchors ?? [])].map(async (target) => {
            const box = await target.boundingBox();
            if (!box) throw new Error("A hero region or anchor is not on screen");
            return box;
          }),
        );
        clip = heroClip(
          boxes,
          await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
        );
      }
      const webp = await toWebp(page, await clipShot(page, clip, "still"));
      const file = `${shot.name}-${theme}.webp`;
      writeFileSync(join(dir, file), webp);
      pair[theme] = file;
      size = readPicture(webp)?.size ?? size;
    }
  } finally {
    await themed(app, page);
  }
  return { dark: pair.dark ?? "", light: pair.light ?? "", ...size };
}
