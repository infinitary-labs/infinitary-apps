import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { appWindows, markMainWindow, openMainWindows } from "./windows";

const all = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => all.windows } }));
vi.mock("./host/taskBrowser", () => ({ isTaskBrowserWindow: () => false }));
vi.mock("./mediaProbe", () => ({ isMediaProbeWindow: () => false }));

/** A stand-in for Electron's window, as far as which windows the app counts reads it. */
const window = (destroyed = false) =>
  ({ isDestroyed: () => destroyed }) as unknown as BrowserWindow;

describe("the windows a person uses", () => {
  // The review of INF-5409: a second launch is answered, and a window brought forward or opened
  // again, only for a main window. A panel's hidden capture is a window of the app too, but no
  // person can use it, so with only a capture left the app has no window to show.
  it("counts only main windows, never a panel's capture left after the last one closed", () => {
    const main = window();
    const capture = window();
    markMainWindow(main);
    all.windows = [capture, main];
    expect(openMainWindows()).toEqual([main]);
    // The last main window closed while a panel was being captured.
    all.windows = [capture];
    expect(appWindows()).toEqual([capture]);
    expect(openMainWindows()).toEqual([]);
    // One closing, not yet gone from Electron's list, is not open either.
    const closing = window(true);
    markMainWindow(closing);
    all.windows = [capture, closing];
    expect(openMainWindows()).toEqual([]);
  });
});
