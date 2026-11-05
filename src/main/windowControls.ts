import type { WindowControl, WindowState } from "@shared/channels/shell";
import { app, type BrowserWindow } from "electron";
import { hostPlatform } from "../core/platform";

/**
 * The window's own buttons where the app draws them (design skill readme,
 * "Linux desktop conventions"): a desktop without a Mac's inset buttons
 * gets a window with no system frame, and the top bar's Minimize, Maximize
 * or Restore and Close window ask the main process to do what the system's
 * buttons would. Closing is the window's ordinary close, so it takes the
 * same path the desktop's own close takes (./app.ts keeps Firstmate working).
 */

export function windowState(win: BrowserWindow): WindowState {
  return { maximized: !win.isDestroyed() && win.isMaximized() };
}

export function controlWindow(win: BrowserWindow, control: WindowControl): WindowState {
  if (control === "front") {
    // A window kept hidden, as every e2e run's is, stays hidden and takes
    // no focus from the person's own apps.
    if (!win.isVisible() && !win.isMinimized()) return windowState(win);
    if (win.isMinimized()) win.restore();
    win.show();
    // A Mac only hands focus to an app that asks for it while another app
    // is in front, as the browser is when a sign-in finishes there.
    if (hostPlatform() === "darwin") app.focus({ steal: true });
    win.focus();
  } else if (control === "minimize") win.minimize();
  else if (control === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else win.close();
  return windowState(win);
}

/** Tells the window's page each time the window fills the screen or stops filling it. */
export function followWindowState(win: BrowserWindow): void {
  const tell = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send("inf:window:state", windowState(win));
  };
  win.on("maximize", tell);
  win.on("unmaximize", tell);
}
