import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CDPSession,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { readPicture } from "../../src/core/pictureFormat";
import { MAX_HERO_BYTES, MAX_HERO_WIDTH, PICTURES_DIR } from "../../src/core/releaseNotes/catalog";
import type { PushChannel } from "../../src/shared/ipc";
import type { ShellPreferences, Theme } from "../../src/shared/preferences";
import { atRest, within } from "./layout";
import { appOf, readInMain } from "./mainProcess";

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
  const windowId = await (await app.browserWindow(page)).evaluate((window) => window.id);
  await app.evaluate(
    ({ BrowserWindow, nativeTheme }, { channel, shown, windowId }) => {
      // A hidden task browser may be first; theme the window whose page we photograph.
      const appWindow = BrowserWindow.fromId(windowId);
      if (!appWindow) throw new Error("No window to show the theme in");
      nativeTheme.themeSource = shown.appearance.theme;
      appWindow.webContents.send(channel, shown);
    },
    { channel, shown, windowId },
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
 *
 * Chromium already waits for the page's next drawn frame, and for a frame at
 * the window's current size, before it copies, so the capture needs no wait
 * of its own. When Chromium refuses it all the same, the picture fails with
 * what the window showed just after (`refusedPicture`), never a second try.
 */
async function drawnWindow(page: Page, motion: "still" | "allow"): Promise<Buffer> {
  const session = await page.context().newCDPSession(page);
  try {
    const release = await holdStill(page, motion === "still");
    const asked = performance.now();
    let refusal: unknown;
    try {
      const { data } = await session.send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    } catch (error) {
      refusal = error;
    } finally {
      await release();
    }
    throw await refusedPicture(page, session, refusal, performance.now() - asked);
  } finally {
    await session.detach();
  }
}

/** The words a refused picture's error is made of; its check reads them here. */
export const REFUSED_PICTURE = {
  refused: "Chromium refused the window picture",
  drew: "drew two frames",
  sameCopy: "same copy now",
  freshCopy: "fresh copy now",
  works: "works",
} as const;

/**
 * How long a refused picture's error waits for the page to draw two frames.
 * A shown window draws them at the display's rate; a hidden Linux window
 * draws about one a second (`paintLikeAMac` in launch.ts), so two seconds
 * tell a slow page from one that has stopped drawing.
 */
const DRAWING_READ_MS = 2_000;

/**
 * The error a refused picture fails with: Chromium's refusal and how long it
 * took, then what the window showed just after, so a rare refusal names its
 * cause where it happens instead of needing a reproduction. Each line
 * separates causes the copy path allows: the window hidden or minimized,
 * the page no longer drawing, a page or graphics process that started again,
 * a refusal that lasts or one already over, and whether a fresh surface (a
 * clip makes Chromium draw one) copies where the held one did not. Its copies
 * answer only whether one works now; neither becomes the picture.
 */
async function refusedPicture(
  page: Page,
  session: CDPSession,
  refusal: unknown,
  tookMs: number,
): Promise<Error> {
  const said = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).split("\n")[0];
  const ms = (from: number) => `${Math.round(performance.now() - from)} ms`;
  const read = async (name: string, reading: () => Promise<string>) => {
    try {
      return `${name}: ${await reading()}`;
    } catch (error) {
      return `${name}: unread (${said(error)})`;
    }
  };
  let size = { width: 0, height: 0 };
  let pagePid: number | undefined;
  const launched = appOf(page);
  const lines = [
    await read("page", async () => {
      const asked = performance.now();
      const state = await page.evaluate(() => ({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        width: innerWidth,
        height: innerHeight,
        ratio: devicePixelRatio,
        age: Math.round(performance.now()),
      }));
      size = { width: state.width, height: state.height };
      return [
        state.visibility,
        state.focused ? "focused" : "unfocused",
        `${state.width} × ${state.height} page pixels at ${state.ratio}×`,
        `answered in ${ms(asked)}`,
        `its document began ${state.age} ms ago`,
      ].join(", ");
    }),
    await read("window", async () => {
      if (!launched) return "unread (the launcher did not start this app)";
      const state = await readInMain(async () =>
        (await launched.browserWindow(page)).evaluate((win) => ({
          visible: win.isVisible(),
          minimized: win.isMinimized(),
          focused: win.isFocused(),
          content: win.getContentSize(),
          captured: win.webContents.isBeingCaptured(),
          crashed: win.webContents.isCrashed(),
          zoom: win.webContents.getZoomFactor(),
          pid: win.webContents.getOSProcessId(),
        })),
      );
      pagePid = state.pid;
      return [
        state.visible ? "shown" : "hidden",
        ...(state.minimized ? ["minimized"] : []),
        state.focused ? "focused" : "unfocused",
        ...(state.captured ? ["being captured"] : []),
        ...(state.crashed ? ["its page crashed"] : []),
        `content ${state.content.join(" × ")}`,
        `zoom ${state.zoom}`,
      ].join(", ");
    }),
    await read("processes", async () => {
      if (!launched) return "unread (the launcher did not start this app)";
      const metrics = await readInMain(() =>
        launched.evaluate(({ app }) => {
          const now = Date.now();
          return app.getAppMetrics().map((metric) => ({
            type: metric.type,
            pid: metric.pid,
            age: Math.round(now - metric.creationTime),
          }));
        }),
      );
      return metrics
        .map(
          (metric) =>
            `${metric.type}${metric.pid === pagePid ? " (this page)" : ""} started ${metric.age} ms ago`,
        )
        .join(", ");
    }),
    await read("drawing", async () => {
      const drew = await page.evaluate(
        (quietMs) =>
          new Promise<number | undefined>((resolve) => {
            const start = performance.now();
            const quiet = setTimeout(() => resolve(undefined), quietMs);
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                clearTimeout(quiet);
                resolve(Math.round(performance.now() - start));
              }),
            );
          }),
        DRAWING_READ_MS,
      );
      return drew === undefined
        ? `drew fewer than two frames in ${DRAWING_READ_MS} ms`
        : `${REFUSED_PICTURE.drew} in ${drew} ms`;
    }),
  ];
  const copy = async (clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  }) => {
    const asked = performance.now();
    try {
      await session.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
      return `${REFUSED_PICTURE.works} in ${ms(asked)}`;
    } catch (error) {
      return `refused in ${ms(asked)} (${said(error)})`;
    }
  };
  lines.push(`${REFUSED_PICTURE.sameCopy}: ${await copy()}`);
  lines.push(
    size.width && size.height
      ? `${REFUSED_PICTURE.freshCopy}, the whole page as a clip: ${await copy({ x: 0, y: 0, ...size, scale: 1 })}`
      : `${REFUSED_PICTURE.freshCopy}: unread (the page's size is unknown)`,
  );
  return new Error(
    [
      `${REFUSED_PICTURE.refused} after ${Math.round(tookMs)} ms: ${said(refusal)}`,
      "What the window showed just after:",
      ...lines.map((line) => `  ${line}`),
    ].join("\n"),
    { cause: refusal },
  );
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
  return heroShotShowing(page, shot, (theme) => themed(app, page, theme));
}

/**
 * `heroShot` for a window with no Electron app handle, such as an installed
 * copy a journey reaches through its debugging port: `show` shows each
 * theme, and with no theme puts the one it found back.
 */
export async function heroShotShowing(
  page: Page,
  shot: HeroShot,
  show: (theme?: Theme) => Promise<void>,
): Promise<HeroPair> {
  const dir = shot.dir ?? PICTURES_DIR;
  mkdirSync(dir, { recursive: true });
  let clip: Box | undefined;
  const pair: Partial<HeroPair> = {};
  let size = { width: 0, height: 0 };
  try {
    for (const theme of ["dark", "light"] as const) {
      await show(theme);
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
    await show();
  }
  return { dark: pair.dark ?? "", light: pair.light ?? "", ...size };
}
