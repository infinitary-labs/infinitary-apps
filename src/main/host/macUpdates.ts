import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { ACTIVE_MARK_HEADER } from "@core/update/activeMark";
import {
  type MacUpdateDriver,
  type MacUpdateOffer,
  MacUpdateProblem,
  MacUpdateReadyProblem,
} from "@core/update/macUpdates";
import { versionFeed, versionManifestUrl } from "@core/update/releaseFeeds";
import { releaseSource } from "@core/update/releaseSource";
import { UPDATE_PROBLEMS } from "@shared/updateWords";
import { app, autoUpdater } from "electron";
import type {
  MacUpdater,
  Provider,
  ResolvedUpdateFileInfo,
  UpdateCheckResult,
  UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { readMacInstallation } from "./macInstallation";

/**
 * Where electron-updater keeps a random per-install ID, in the data folder, to place a copy in a
 * staged rollout. Unpatched, it also sends that ID with every feed read. The one identifier that
 * leaves for us is Diagnostics' install ID (docs/sharing.md), so our patch of the library
 * (patches/electron-updater@6.8.9.patch) sends none, every copy takes every release, and an
 * earlier version's file is removed (docs/alpha.md, "Update channels").
 */
export const UPDATER_ID_FILE = ".updaterId";

/** The release feed the library reads a channel from. */
const CHANNEL_FEED = {
  provider: "generic",
  url: releaseSource.feedUrl,
  useMultipleRangeRequest: false,
} as const;

/**
 * A provider the library reads one exact version from, its own published
 * manifest beside the channel feeds (docs/view.md, "Following the home's
 * version"), with the same metadata and checks a channel's feed gets.
 */
function versionProvider(base: typeof Provider) {
  return class VersionFeed extends base<UpdateInfo> {
    constructor(
      private readonly feed: { version: string },
      _updater: unknown,
      runtimeOptions: ProviderRuntimeOptions,
    ) {
      super(runtimeOptions);
    }
    async getLatestVersion(): Promise<UpdateInfo> {
      const url = versionManifestUrl(releaseSource.feedUrl, this.feed.version);
      const text = await this.httpRequest(url);
      if (text === null) throw new Error("The published manifest was empty.");
      return versionFeed(text, this.feed.version) as UpdateInfo;
    }
    resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
      return info.files.map((file) => ({ url: new URL(file.url), info: file }));
    }
  };
}

/** Electron/Squirrel owns signed app replacement; core owns subscription and consent (INF-640). */
export function createMacUpdateDriver(prepareRestart: () => Promise<void>): MacUpdateDriver {
  // The library's own place for it this run; nothing reads it any more.
  void rm(join(app.getPath("userData"), UPDATER_ID_FILE), { force: true }).catch(() => {});
  let updater: MacUpdater | undefined;
  let exact: ReturnType<typeof versionProvider> | undefined;
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
      const { MacUpdater, Provider } = await import("electron-updater");
      exact = versionProvider(Provider);
      updater = new MacUpdater(CHANNEL_FEED);
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.disableDifferentialDownload = true;
      // Every copy takes every release, so a feed naming a staged rollout never makes the
      // library mint its per-install ID (UPDATER_ID_FILE).
      updater.isUserWithinRollout = () => true;
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
    check: (channel, mark) =>
      serial(async () => {
        const current = await engine();
        current.channel = channel === "stable" ? "latest" : "alpha";
        current.allowPrerelease = channel === "alpha";
        // The library's channel setter enables downgrades. Always turn them off afterward.
        current.allowDowngrade = false;
        // The active mark rides this feed read alone: the library hands its request headers to
        // every request, and a download must never carry it (src/core/update/activeMark.ts).
        current.requestHeaders = mark ? { [ACTIVE_MARK_HEADER]: mark.value } : null;
        try {
          checked = await current.checkForUpdates();
        } catch (error) {
          if ((error as { code?: string }).code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") {
            checked = null;
            return null;
          }
          // A failed read keeps the offer it last found, which the library keeps too, so
          // Update and restart can still download that version (docs/alpha.md "Update channels").
          throw error;
        } finally {
          current.requestHeaders = null;
        }
        // A result means the library read the feed; an inactive library answers null and reads nothing.
        if (checked) mark?.answered();
        return checked
          ? {
              version: checked.updateInfo.version,
              releaseUrl: releaseSource.releaseUrl(checked.updateInfo.version),
            }
          : null;
      }),
    checkVersion: (version) =>
      serial(async () => {
        const current = await engine();
        if (!exact) throw new Error("The update library did not load.");
        // This read alone goes to the version's manifest; the download keeps the provider it found.
        current.setFeedURL({ provider: "custom", updateProvider: exact, version } as never);
        current.allowDowngrade = false;
        current.requestHeaders = null;
        try {
          checked = await current.checkForUpdates();
        } catch (error) {
          checked = null;
          // A version with no manifest is not published: nothing to offer.
          if ((error as { statusCode?: number }).statusCode === 404) return null;
          throw error;
        } finally {
          current.setFeedURL(CHANNEL_FEED);
        }
        // As a channel's read, the offer is the version read; the core decides it is newer.
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
    install: async (stillWanted) => {
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
      // Staged: someone who started using the app meanwhile keeps it, and it restarts later.
      if (stillWanted && !stillWanted()) return false;
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
