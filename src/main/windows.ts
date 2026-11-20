import { BrowserWindow } from "electron";
import { isTaskBrowserWindow } from "./host/taskBrowser";
import { isMediaProbeWindow } from "./mediaProbe";

/**
 * The app's own windows: every window but a task browser's hidden pages
 * (./host/taskBrowser.ts) and the media probe's (./mediaProbe.ts). An app
 * push, a reload, a focus, a notification's click or the dock's activate
 * reaches these and never a task's page, whose content is a project's, not
 * the app's, nor a recording being checked.
 */
export function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !isTaskBrowserWindow(win) && !isMediaProbeWindow(win),
  );
}

const mainWindows = new WeakSet<BrowserWindow>();

/** Marks the app's main window, the one that shows the crew, Settings and its Keyboard settings. */
export function markMainWindow(win: BrowserWindow): void {
  mainWindows.add(win);
}

/**
 * Whether a main window is open now: one that installs the keys Keyboard
 * settings shows, never a hidden helper such as a panel's capture.
 */
export function mainWindowOpen(): boolean {
  return BrowserWindow.getAllWindows().some((win) => mainWindows.has(win) && !win.isDestroyed());
}

/**
 * The window a system confirmation belongs to on Windows (Windows Hello or
 * the password, ./host/windowsFreshAuthentication.ts): the app's focused
 * window, else its first visible one, by its native handle. Absent in a run
 * with no window, where the dialog stands on its own.
 */
export function confirmationWindow(): Buffer | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  const own = appWindows();
  const win =
    focused && own.includes(focused) ? focused : own.find((candidate) => candidate.isVisible());
  return win?.getNativeWindowHandle();
}
