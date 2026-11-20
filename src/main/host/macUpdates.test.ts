import type { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { app, autoUpdater } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releaseSource } from "../../core/update/releaseSource";
import { INFINITARY_TAP } from "../../core/update/updateChannels";
import { readMacInstallation } from "./macInstallation";
import { createMacUpdateDriver } from "./macUpdates";

const state = vi.hoisted(() => ({
  engine: null as unknown as EventEmitter & {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowDowngrade: boolean;
    allowPrerelease: boolean;
    channel: string;
    disableDifferentialDownload: boolean;
  },
  checked: vi.fn(),
  downloaded: vi.fn(),
  quit: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("./macInstallation", () => ({ readMacInstallation: vi.fn(() => ({ kind: "direct" })) }));
vi.mock("node:fs/promises", () => ({ access: vi.fn(async () => {}), rm: vi.fn(async () => {}) }));
vi.mock("node:os", () => ({ release: () => "24.6.0" }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const native = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
  return {
    app: {
      isPackaged: true,
      isInApplicationsFolder: vi.fn(() => true),
      getPath: () => "/Users/someone/Library/Application Support/infinitary",
    },
    autoUpdater: native,
  };
});
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    // The base of the exact-version feed; macUpdateFeed.test.ts reads that feed through the real one.
    Provider: class {},
    MacUpdater: class extends EventEmitter {
      autoDownload = true;
      autoInstallOnAppQuit = true;
      allowDowngrade = false;
      allowPrerelease = false;
      disableDifferentialDownload = false;
      private chosen = "";
      set channel(value: string) {
        this.chosen = value;
        this.allowDowngrade = true;
      }
      get channel() {
        return this.chosen;
      }
      constructor() {
        super();
        state.engine = this;
      }
      checkForUpdates = state.checked;
      downloadUpdate = state.downloaded;
      quitAndInstall = state.quit;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMacInstallation).mockReturnValue({ kind: "direct" });
  autoUpdater.removeAllListeners();
  vi.mocked(app.isInApplicationsFolder).mockReturnValue(true);
  vi.mocked(access).mockResolvedValue();
  state.checked.mockResolvedValue({
    isUpdateAvailable: true,
    updateInfo: { version: "0.5.0-alpha.10" },
    cancellationToken: { cancel: state.cancel },
  });
  state.downloaded.mockResolvedValue([]);
});

// INF-640: the Electron adapter never silently downloads, downgrades, installs on quit or bypasses shutdown.
describe("Mac updater native effects", () => {
  // Captain's revised INF-643: a Homebrew-owned copy never reaches the native updater.
  it("refuses Homebrew ownership even if it changes after the offer was checked", async () => {
    const shutdown = vi.fn();
    const driver = createMacUpdateDriver(shutdown);
    const offer = await driver.check("alpha");
    if (!offer) throw new Error("fixture must offer an update");
    vi.mocked(readMacInstallation).mockReturnValue({
      kind: "homebrew",
      channel: "alpha",
      tap: INFINITARY_TAP,
    });
    await expect(driver.download(offer, vi.fn(), new AbortController().signal)).rejects.toThrow(
      "Homebrew",
    );
    await expect(driver.install()).rejects.toThrow("Homebrew");
    await expect(driver.check("stable")).rejects.toThrow("Homebrew");
    expect(state.downloaded).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(state.quit).not.toHaveBeenCalled();
  });

  it("sets the requested feed channel, then disables downgrades and automatic effects", async () => {
    const driver = createMacUpdateDriver(vi.fn());
    expect(await driver.check("alpha")).toEqual({
      version: "0.5.0-alpha.10",
      releaseUrl: releaseSource.releaseUrl("0.5.0-alpha.10"),
    });
    expect(state.engine).toMatchObject({
      channel: "alpha",
      allowPrerelease: true,
      allowDowngrade: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      disableDifferentialDownload: true,
    });
    await driver.check("stable");
    expect(state.engine).toMatchObject({
      channel: "latest",
      allowPrerelease: false,
      allowDowngrade: false,
    });
    expect(state.downloaded).not.toHaveBeenCalled();
    expect(state.quit).not.toHaveBeenCalled();
  });

  it("refuses a mounted or unwritable app before downloading", async () => {
    const driver = createMacUpdateDriver(vi.fn());
    const offer = await driver.check("alpha");
    if (!offer) throw new Error("fixture must offer the next alpha");
    vi.mocked(app.isInApplicationsFolder).mockReturnValue(false);
    await expect(driver.download(offer, vi.fn(), new AbortController().signal)).rejects.toThrow(
      "Copy Infinitary into Applications",
    );
    vi.mocked(app.isInApplicationsFolder).mockReturnValue(true);
    vi.mocked(access).mockRejectedValue(new Error("EACCES"));
    await expect(driver.download(offer, vi.fn(), new AbortController().signal)).rejects.toThrow(
      "cannot replace this copy",
    );
    expect(state.downloaded).not.toHaveBeenCalled();
  });

  it("passes progress and cancellation to the pinned download without staging it", async () => {
    const driver = createMacUpdateDriver(vi.fn());
    const offer = await driver.check("alpha");
    if (!offer) throw new Error("fixture must offer the next alpha");
    const controller = new AbortController();
    const progress = vi.fn();
    state.downloaded.mockImplementation(async () => {
      state.engine.emit("download-progress", { percent: 42 });
      controller.abort();
    });
    await driver.download(offer, progress, controller.signal);
    expect(progress).toHaveBeenCalledWith(42);
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.engine.listenerCount("download-progress")).toBe(0);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(state.quit).not.toHaveBeenCalled();
  });

  it("refuses an offer that a later check replaced", async () => {
    const driver = createMacUpdateDriver(vi.fn());
    const old = await driver.check("alpha");
    if (!old) throw new Error("fixture must offer the next alpha");
    state.checked.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: "0.5.0" } });
    await driver.check("stable");
    await expect(driver.download(old, vi.fn(), new AbortController().signal)).rejects.toThrow(
      "offer changed",
    );
    expect(state.downloaded).not.toHaveBeenCalled();
  });

  it("waits for native signature/staging success and finished shutdown before replacement", async () => {
    const order: string[] = [];
    let finishShutdown!: () => void;
    const disposed = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    let shutdownStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      shutdownStarted = resolve;
    });
    const driver = createMacUpdateDriver(async () => {
      order.push("shutdown");
      shutdownStarted();
      await disposed;
      order.push("settled");
    });
    await driver.check("alpha");
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => {
      order.push("native check");
      autoUpdater.emit("update-downloaded");
    });
    state.quit.mockImplementation(() => {
      order.push("replace");
    });
    const installing = driver.install();
    await started;
    expect(order).toEqual(["native check", "shutdown"]);
    expect(state.quit).not.toHaveBeenCalled();
    finishShutdown();
    await installing;
    expect(order).toEqual(["native check", "shutdown", "settled", "replace"]);
  });

  it("does not shut down or replace after native signature verification fails", async () => {
    const shutdown = vi.fn();
    const driver = createMacUpdateDriver(shutdown);
    await driver.check("alpha");
    let checked!: () => void;
    const nativeCheck = new Promise<void>((resolve) => {
      checked = resolve;
    });
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => {
      checked();
    });
    const installing = driver.install();
    const failed = expect(installing).rejects.toThrow("Signature refused");
    await nativeCheck;
    expect(() => {
      const error = new Error("Signature refused");
      state.engine.emit("error", error);
      autoUpdater.emit("error", error);
    }).not.toThrow();
    await failed;
    expect(shutdown).not.toHaveBeenCalled();
    expect(state.quit).not.toHaveBeenCalled();
    expect(autoUpdater.listenerCount("update-downloaded")).toBe(0);
  });
  it("keeps running, staged, when someone came back while native staging was pending, and later quits with no staging", async () => {
    const shutdown = vi.fn(async () => {});
    const driver = createMacUpdateDriver(shutdown);
    await driver.check("alpha");
    let checked!: () => void;
    const nativeCheck = new Promise<void>((resolve) => {
      checked = resolve;
    });
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => {
      checked();
    });
    let nobodyHere = true;
    const installing = driver.install(() => nobodyHere);
    await nativeCheck;
    // A window came to the front while Squirrel staged.
    nobodyHere = false;
    autoUpdater.emit("update-downloaded");
    expect(await installing).toBe("staged");
    expect(shutdown).not.toHaveBeenCalled();
    expect(state.quit).not.toHaveBeenCalled();
    nobodyHere = true;
    await driver.install(() => nobodyHere);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(state.quit).toHaveBeenCalledOnce();
  });
  it("does not stage twice when shutdown must be tried again", async () => {
    const shutdown = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
    const driver = createMacUpdateDriver(shutdown);
    await driver.check("alpha");
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => {
      autoUpdater.emit("update-downloaded");
    });
    await expect(driver.install()).rejects.toThrow("update is ready");
    expect(state.quit).not.toHaveBeenCalled();
    await driver.install();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(state.quit).toHaveBeenCalledTimes(1);
  });
});
