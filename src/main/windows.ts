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
