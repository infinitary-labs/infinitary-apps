/// <reference types="vite/client" />
import { readFileSync } from "node:fs";
import type { DataRefusal } from "@core/storage/dataFolderRefusal";
import {
  SAVED_DATA_REFUSAL_MESSAGE,
  SAVED_DATA_REFUSAL_TITLE,
} from "@core/storage/savedDataCompatibility";
import type { ResetAnswer } from "@shared/reset";
import { app, BrowserWindow } from "electron";
import colors from "../renderer/src/design/tokens/colors.css?raw";
import effects from "../renderer/src/design/tokens/effects.css?raw";
import spacing from "../renderer/src/design/tokens/spacing.css?raw";
import typography from "../renderer/src/design/tokens/typography.css?raw";
import { frameFontFiles } from "./frames/fontFiles";
import { followResetScreen } from "./reset/screen";
import { REQUIRED_WEB_PREFERENCES } from "./security/baseline";
import { markRefusalWindow } from "./windows";

const SAVED_DATA_REFUSAL: DataRefusal = {
  title: SAVED_DATA_REFUSAL_TITLE,
  message: SAVED_DATA_REFUSAL_MESSAGE,
  next: "You can close this window and use a compatible version.",
};

/** A standalone, offline refusal: no preload, service bridge, or normal shell. */
export async function showSavedDataRefusal(
  hidden: boolean,
  reset?: () => Promise<ResetAnswer>,
): Promise<void> {
  await showDataRefusal(hidden, SAVED_DATA_REFUSAL, reset);
}

/**
 * Shows why the folder is not opened. With `reset`, the window also offers
 * Reset Infinitary, which asks in place first (./reset/screen.ts,
 * docs/reset.md, "Where a reset can start").
 */
export async function showDataRefusal(
  hidden: boolean,
  refusal: DataRefusal,
  reset?: () => Promise<ResetAnswer>,
): Promise<void> {
  const win = standaloneWindow({
    title: "Infinitary",
    width: 640,
    height: reset ? 420 : 360,
  });
  // The window a second launch brings forward (./windows.ts), unless held hidden for a capture.
  if (!hidden) markRefusalWindow(win);
  win.on("closed", () => app.quit());
  if (reset) {
    await followResetScreen({ win, words: refusal, again: false, reset });
    if (!hidden) win.show();
    return;
  }
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  const html = standaloneDocument({
    title: "Infinitary",
    body: `<main aria-label="Saved work protection">
    <h1>${refusal.title}</h1><p>${refusal.message}</p>
    <p>${refusal.next}</p></main>`,
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (!hidden) win.show();
}

/**
 * A window for a standalone page: no preload, no service bridge, no child
 * windows. Shown by its caller once the page is in. The one-time move's
 * hand-over (./handOver.ts) uses it too.
 */
export function standaloneWindow(input: {
  title: string;
  width: number;
  height: number;
  backgroundColor?: string;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: input.width,
    height: input.height,
    show: false,
    title: input.title,
    ...(input.backgroundColor ? { backgroundColor: input.backgroundColor } : {}),
    webPreferences: REQUIRED_WEB_PREFERENCES,
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return win;
}

function fontFace(file: string, family: string, weights: string): string {
  const font = Object.entries(frameFontFiles).find(([name]) => name === file);
  return font
    ? `@font-face { font-family: '${family}'; src: url(data:font/woff2;base64,${readFileSync(font[1]).toString("base64")}) format('woff2'); font-weight: ${weights}; }`
    : "";
}

/**
 * A standalone, offline page in the design system's own tokens and type: no
 * script of its own, nothing loaded, forms allowed to submit only so a
 * window can read the button pressed from its navigation.
 */
export function standaloneDocument(input: {
  title: string;
  body: string;
  css?: string;
  theme?: "dark" | "light";
}): string {
  const fonts = [
    fontFace("spacegrotesk-latin.woff2", "Space Grotesk", "300 700"),
    fontFace("jetbrainsmono-normal-latin.woff2", "JetBrains Mono", "100 800"),
  ].join("\n");
  return `<!doctype html><html${input.theme === "light" ? ' data-theme="light"' : ""}><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:">
    <title>${input.title}</title><style>${colors}${spacing}${typography}${effects}${fonts}
    body { margin: 0; padding: var(--space-7); color: var(--fg-2); }
    h1 { font-size: var(--text-lg); font-weight: var(--weight-medium); color: var(--fg-1); margin: 0 0 var(--space-5); }
    p { margin: 0 0 var(--space-5); }
    ${input.css ?? ""}
    </style></head><body>${input.body}</body></html>`;
}
