import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  appWindows,
  isStartingOver,
  markMainWindow,
  openMainWindows,
  startWindowsOver,
} from "./windows";

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

/** A stand-in for a window and its page, as far as starting over reads them. */
const pageWindow = () => {
  const webContents = Object.assign(new EventEmitter(), { reload: vi.fn() });
  return { isDestroyed: () => false, webContents } as unknown as BrowserWindow & {
    webContents: EventEmitter & { reload: ReturnType<typeof vi.fn> };
  };
};

describe("a window starting over", () => {
  // INF-6938: a paired view's page was read just after it said "in reach" and was gone, since the
  // page a joining window leaves heard the joined first mate's pushes until its new page committed.
  it("hears no push from its start-over until its new page commits", () => {
    const joining = pageWindow();
    const other = pageWindow();
    all.windows = [joining, other];
    startWindowsOver();
    expect(joining.webContents.reload).toHaveBeenCalledTimes(1);
    expect(other.webContents.reload).toHaveBeenCalledTimes(1);
    expect(isStartingOver(joining.webContents)).toBe(true);
    expect(isStartingOver(other.webContents)).toBe(true);
    joining.webContents.emit("did-navigate");
    expect(isStartingOver(joining.webContents)).toBe(false);
    expect(isStartingOver(other.webContents)).toBe(true);
    // The new page's own loading ends later; it changes nothing and leaves no listener behind.
    joining.webContents.emit("did-stop-loading");
    expect(joining.webContents.listenerCount("did-navigate")).toBe(0);
    expect(joining.webContents.listenerCount("did-stop-loading")).toBe(0);
  });

  it("hears pushes again when its start-over ends without a new page", () => {
    const failing = pageWindow();
    all.windows = [failing];
    startWindowsOver();
    failing.webContents.emit("did-stop-loading");
    expect(isStartingOver(failing.webContents)).toBe(false);
  });

  it("starts over again while one is under way, and the one new page ends both", () => {
    const twice = pageWindow();
    all.windows = [twice];
    startWindowsOver();
    startWindowsOver();
    expect(twice.webContents.reload).toHaveBeenCalledTimes(2);
    expect(twice.webContents.listenerCount("did-navigate")).toBe(1);
    twice.webContents.emit("did-navigate");
    expect(isStartingOver(twice.webContents)).toBe(false);
  });
});
