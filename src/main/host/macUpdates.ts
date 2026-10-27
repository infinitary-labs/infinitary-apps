import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { release } from "node:os";
import { dirname } from "node:path";
import {
  type MacUpdateDriver,
  type MacUpdateOffer,
  MacUpdateProblem,
  MacUpdateReadyProblem,
} from "@core/update/macUpdates";
import { releaseSource } from "@core/update/releaseSource";
import type { UpdateChannel } from "@shared/update";
import { UPDATE_PROBLEMS } from "@shared/updateWords";
import { app, autoUpdater } from "electron";
import type { MacUpdater, UpdateCheckResult } from "electron-updater";
import { readMacInstallation } from "./macInstallation";

/** Electron/Squirrel owns signed app replacement; core owns subscription and consent (INF-640). */
export function createMacUpdateDriver(prepareRestart: () => Promise<void>): MacUpdateDriver {
  let updater: MacUpdater | undefined;
  let checked: UpdateCheckResult | null = null;
  let nativeReady = false;
  let queue: Promise<unknown> = Promise.resolve();
  // The library shares the checked offer with downloadUpdate. Serialize checks so an older
  // channel request can never replace a newer request's provider or download target.
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }
  function requireDirectCopy(): void {
    if (readMacInstallation().kind !== "direct")
      throw new MacUpdateProblem(UPDATE_PROBLEMS.installation);
  }
  async function engine(): Promise<MacUpdater> {
    requireDirectCopy();
    if (!updater) {
      const { MacUpdater } = await import("electron-updater");
      updater = new MacUpdater({
        provider: "generic",
        url: releaseSource.feedUrl,
        useMultipleRangeRequest: false,
      });
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.disableDifferentialDownload = true;
      // The UI reports bounded, readable errors, not URLs, headers or the loopback proxy's secret.
      updater.logger = null;
      // The library forwards native errors through its own EventEmitter. An unhandled
      // error event would crash the app before our awaited operation can report it.
      updater.on("error", () => {});
    }
    return updater;
  }
  return {
    installation: readMacInstallation(),
    check: (channel: UpdateChannel) =>
      serial(async () => {
        const current = await engine();
        current.channel = channel === "stable" ? "latest" : "alpha";
        current.allowPrerelease = channel === "alpha";
        // The library's channel setter enables downgrades. Always turn them off afterward.
        current.allowDowngrade = false;
        try {
          checked = await current.checkForUpdates();
        } catch (error) {
          checked = null;
          if ((error as { code?: string }).code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")
            return null;
          throw error;
        }
        return checked
          ? {
              version: checked.updateInfo.version,
              releaseUrl: releaseSource.releaseUrl(checked.updateInfo.version),
            }
          : null;
      }),
    download: (offer: MacUpdateOffer, progress, signal) =>
      serial(async () => {
        if (!app.isPackaged || Number(release().split(".")[0]) < 21)
          throw new MacUpdateProblem(
            "Install Infinitary on macOS Monterey or later to use in-app updates.",
          );
        const bundle = dirname(dirname(dirname(process.execPath)));
        // A translocated or mounted app is not a writable installation. Do not ask Squirrel to
        // move it, or quietly choose another copy; the person installs from the disk image first.
        if (!app.isInApplicationsFolder())
          throw new MacUpdateProblem(
            "Copy Infinitary into Applications and open that copy before updating.",
          );
        try {
          await access(bundle, constants.W_OK);
          await access(dirname(bundle), constants.W_OK);
        } catch {
          throw new MacUpdateProblem(UPDATE_PROBLEMS.unwritable);
        }
        const current = await engine();
        if (
          !checked?.isUpdateAvailable ||
          checked.updateInfo.version !== offer.version ||
          signal.aborted
        )
          throw new Error("The update offer changed.");
        const cancellation = checked.cancellationToken;
        const cancel = () => cancellation?.cancel();
        const onProgress = (info: { percent: number }) => progress(info.percent);
        signal.addEventListener("abort", cancel, { once: true });
        current.on("download-progress", onProgress);
        try {
          await current.downloadUpdate(cancellation);
        } finally {
          signal.removeEventListener("abort", cancel);
          current.removeListener("download-progress", onProgress);
        }
      }),
    install: async () => {
      const current = await engine();
      // With autoInstallOnAppQuit=false, the library has only downloaded and checksummed the
      // ZIP. Native staging (including signature verification) starts only after consent.
      if (!nativeReady)
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            autoUpdater.removeListener("error", failed);
            autoUpdater.removeListener("update-downloaded", ready);
          };
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          const ready = () => {
            nativeReady = true;
            cleanup();
            resolve();
          };
          autoUpdater.once("error", failed);
          autoUpdater.once("update-downloaded", ready);
          try {
            autoUpdater.checkForUpdates();
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      // Squirrel's quitAndInstall must not outrun the app's asynchronous task/session shutdown.
      try {
        await prepareRestart();
        current.quitAndInstall();
      } catch {
        throw new MacUpdateReadyProblem(UPDATE_PROBLEMS.staged);
      }
    },
  };
}
