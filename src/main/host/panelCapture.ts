import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { appWindows } from "../windows";
import {
  buildCaptureHtml,
  CAPTURE_WINDOW_BACKGROUND,
  type CaptureFrame,
  type CaptureTheme,
} from "./panelCaptureDocument";

/**
 * Photographs one docked side panel in one token theme.
 *
 * The picture is taken of a hidden window whose document is a copy of the
 * panel plus the page's CSS, with `data-theme` set only there. The live
 * window's theme attribute is never written: that write used to flash the
 * whole UI into the light theme (and back) on every `capture_panel`, because
 * the token files key `--bg-0` off `body`. `stayHidden` keeps the capture
 * window from appearing while it paints.
 */

/** A rail animates its width open; the box is read until two reads agree, bounded. */
const CAPTURE_STABLE_POLL_MS = 80;
const CAPTURE_STABLE_MAX_POLLS = 30;

const captureWindows = new Set<BrowserWindow>();

type Box = { width: number; height: number; pending?: boolean };
/** A framed panel's iframe, by the start of its address and its drawn size. */
type FramePlace = { prefix: string; width: number; height: number };
type Snapshot = {
  html: string;
  css: string;
  width: number;
  height: number;
  frames: FramePlace[];
};

function appWindow(): BrowserWindow | null {
  for (const win of appWindows()) {
    if (!win.isDestroyed() && !captureWindows.has(win)) return win;
  }
  return null;
}

function panelMeasureScript(panelId: string): string {
  const id = JSON.stringify(panelId);
  return `(() => {
    const el = document.querySelector('[data-side-panel="' + CSS.escape(${id}) + '"]');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const pending = el.querySelector("[data-frame-mount-pending], iframe[data-frame-mount]:not([data-frame-drawn])") !== null;
    return { width: box.width, height: box.height, pending };
  })()`;
}

/**
 * Collects a document's CSS with its font files inlined, so the hidden capture
 * document needs no fetch. Shared by the window and each panel frame.
 */
const CSS_COLLECTOR = `
    const inlineFonts = async (css, base) => {
      const urls = new Set();
      for (const match of css.matchAll(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g)) {
        const url = match[2];
        if (!url || url.startsWith("data:")) continue;
        if (!/\\.(woff2?|ttf|otf)(\\?|$)/i.test(url)) continue;
        urls.add(url);
      }
      let out = css;
      for (const url of urls) {
        try {
          const absolute = new URL(url, base).href;
          const response = await fetch(absolute);
          if (!response.ok) continue;
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          const data = "data:font/woff2;base64," + btoa(binary);
          out = out.split('url("' + url + '")').join('url("' + data + '")');
          out = out.split("url('" + url + "')").join('url("' + data + '")');
          out = out.split("url(" + url + ")").join('url("' + data + '")');
        } catch {
          // A font that will not inline falls back. The tokens still paint.
        }
      }
      return out;
    };
    const collectCss = async () => {
      if (window.__fmPanelCaptureCss) return window.__fmPanelCaptureCss;
      const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
      const chunks = [];
      for (const sheet of sheets) {
        let text = "";
        try {
          text = [...sheet.cssRules].map((rule) => rule.cssText).join("\\n");
        } catch {
          if (sheet.href) chunks.push('@import url("' + sheet.href + '");');
          continue;
        }
        chunks.push(await inlineFonts(text, sheet.href || document.baseURI));
      }
      window.__fmPanelCaptureCss = chunks.join("\\n");
      return window.__fmPanelCaptureCss;
    };
`;

/**
 * Markup of the docked panel, plus the page CSS with font files inlined so
 * the hidden document does not need to fetch them. Cached on the live page:
 * a capture asks for dark and then light, and the CSS does not change
 * between the two.
 */
function panelSnapshotScript(panelId: string): string {
  const id = JSON.stringify(panelId);
  return `(() => {
    const panelId = ${id};
    const el = document.querySelector('[data-side-panel="' + CSS.escape(panelId) + '"]');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const clone = el.cloneNode(true);
    // A framed panel draws in its own process: each of its frames is read
    // separately and set back in place of this marker.
    const frames = [];
    const live = [...el.querySelectorAll("iframe")];
    clone.querySelectorAll("iframe").forEach((node, i) => {
      const source = live[i];
      const src = source ? source.src : "";
      const at = src.indexOf("://");
      const end = at < 0 ? -1 : src.indexOf("/", at + 3);
      if (!source || end < 0) {
        node.remove();
        return;
      }
      const rect = source.getBoundingClientRect();
      const marker = document.createElement("div");
      marker.setAttribute("data-capture-frame", String(frames.length));
      frames.push({ prefix: src.slice(0, end + 1), width: rect.width, height: rect.height });
      node.replaceWith(marker);
    });
    clone.querySelectorAll("script, object, embed, link, meta").forEach((node) => node.remove());
    const html = clone.outerHTML;
${CSS_COLLECTOR}
    return collectCss().then((css) => ({ html, css, width: box.width, height: box.height, frames }));
  })()`;
}

/** One panel frame's own CSS and body, read inside that frame. */
const FRAME_READ_SCRIPT = `(() => {
${CSS_COLLECTOR}
  const body = document.body ? document.body.cloneNode(true) : null;
  if (!body) return null;
  body.querySelectorAll("script, iframe, object, embed, link, meta").forEach((node) => node.remove());
  return collectCss().then((css) => ({ css, bodyHtml: body.innerHTML }));
})()`;

async function readFrames(win: BrowserWindow, places: FramePlace[]): Promise<CaptureFrame[]> {
  const subtree = win.webContents.mainFrame.framesInSubtree;
  const frames: CaptureFrame[] = [];
  for (const place of places) {
    const frame = subtree.find((candidate) => candidate.url.startsWith(place.prefix));
    const read = frame
      ? ((await frame.executeJavaScript(FRAME_READ_SCRIPT, true).catch(() => null)) as {
          css: string;
          bodyHtml: string;
        } | null)
      : null;
    frames.push({
      css: read?.css ?? "",
      bodyHtml: read?.bodyHtml ?? "",
      width: place.width,
      height: place.height,
    });
  }
  return frames;
}

async function stablePanelBox(win: BrowserWindow, panelId: string): Promise<Box | null> {
  const measure = panelMeasureScript(panelId);
  let box = (await win.webContents.executeJavaScript(measure, true)) as Box | null;
  if (!box || box.width < 1 || box.height < 1) return null;
  // A framed panel still opening draws nothing yet; a capture waits for it, bounded.
  for (let poll = 0; poll < CAPTURE_STABLE_MAX_POLLS; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_STABLE_POLL_MS));
    const next = (await win.webContents.executeJavaScript(measure, true)) as Box | null;
    if (!next || next.width < 1 || next.height < 1) return null;
    const same =
      !next.pending &&
      Math.round(next.width) === Math.round(box.width) &&
      Math.round(next.height) === Math.round(box.height);
    box = next;
    if (same) return box;
  }
  return box;
}

/**
 * The capture documents live in the app's own userData, never the shared
 * temp directory: each is removed once its picture is taken, and whatever a
 * killed process left there is cleared by the next process's first capture.
 */
let captureDir: Promise<string> | undefined;

function captureDocumentDir(): Promise<string> {
  captureDir ??= (async () => {
    const dir = join(app.getPath("userData"), "cache", "panel-capture");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return dir;
  })().catch((error: unknown) => {
    captureDir = undefined;
    throw error;
  });
  return captureDir;
}

async function renderSnapshot(
  anchor: BrowserWindow,
  snapshot: Snapshot,
  frames: CaptureFrame[],
  theme: CaptureTheme,
): Promise<{ png: Buffer; width: number; height: number }> {
  const width = Math.max(1, Math.round(snapshot.width));
  const height = Math.max(1, Math.round(snapshot.height));
  const file = join(await captureDocumentDir(), `${randomUUID()}.html`);
  const shot = new BrowserWindow({
    show: false,
    x: anchor.getPosition()[0],
    y: anchor.getPosition()[1],
    width,
    height,
    useContentSize: true,
    frame: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: CAPTURE_WINDOW_BACKGROUND[theme],
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  captureWindows.add(shot);
  try {
    await writeFile(
      file,
      buildCaptureHtml({
        css: snapshot.css,
        panelHtml: snapshot.html,
        frames,
        theme,
        width,
        height,
      }),
      "utf8",
    );
    await shot.loadFile(file);
    await shot.webContents.executeJavaScript(
      "document.fonts.ready.then(() => document.body.getBoundingClientRect().width)",
      true,
    );
    const image = await shot.webContents.capturePage(undefined, { stayHidden: true });
    const size = image.getSize();
    return { png: image.toPNG(), width: size.width, height: size.height };
  } finally {
    captureWindows.delete(shot);
    if (!shot.isDestroyed()) shot.destroy();
    await rm(file, { force: true }).catch(() => undefined);
  }
}

export async function captureDockedPanel(input: {
  panelId: string;
  theme: CaptureTheme;
}): Promise<{ png: Buffer; width: number; height: number } | null> {
  const win = appWindow();
  if (!win || win.isDestroyed()) return null;
  const box = await stablePanelBox(win, input.panelId);
  if (!box) return null;
  const snapshot = (await win.webContents.executeJavaScript(
    panelSnapshotScript(input.panelId),
    true,
  )) as Snapshot | null;
  if (!snapshot || snapshot.width < 1 || snapshot.height < 1) return null;
  const frames = await readFrames(win, snapshot.frames ?? []);
  return renderSnapshot(win, snapshot, frames, input.theme);
}
