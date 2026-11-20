import type { BrowserWindow } from "electron";
import { shell } from "electron";
import { isAppRendererSource, type RendererSourceOptions } from "./rendererSource";

/**
 * Hosts a vetted link may open in the user's default browser via window.open.
 * Kept deliberately small: the update indicator points at GitHub releases.
 * Card-body links and auth use `isAllowedOpenExternalUrl` over IPC instead.
 */
export const EXTERNAL_URL_ALLOWED_HOSTS = ["github.com", "www.github.com"] as const;

export function isExternalUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return (EXTERNAL_URL_ALLOWED_HOSTS as readonly string[]).includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Navigation lockdown per docs/architecture.md section 4: in-window navigation
 * is limited to our own renderer document (dev reloads); window.open never
 * opens a window - allowlisted https links route to the default browser,
 * everything else is dropped.
 */
export function lockdownNavigation(
  win: BrowserWindow,
  options: RendererSourceOptions,
  openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url),
): void {
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppRendererSource(url, options)) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrlAllowed(url)) {
      void openExternal(url);
    }
    return { action: "deny" };
  });
}
