import type { HostCapabilities } from "@core/host";
import * as m from "@shared/i18n/messages.generated";
import { userDataFolderFor } from "@shared/userDataFolders";
import { app, dialog, Notification, shell } from "electron";
import { hostDesktop, hostPlatform, hostPlatformProfile } from "../../core/platform";
import { createMediaProbe, createTypefaceProbe } from "../mediaProbe";
import { noteNotifiedCard } from "../notifiedCard";
import { packagedFlavor, readPackageJsonAt } from "../userDataDir";
import { appWindows } from "../windows";
import { type AutostartEntry, readAutostart, writeAutostart } from "./autostartEntry";
import { createAxiProcessSpawner } from "./axiProcess";
import { createDesktopKeychain } from "./electronKeychain";
import { macUpdateStandIn } from "./macUpdateStandIn";
import { createMacUpdateDriver } from "./macUpdates";
import { captureDockedPanel } from "./panelCapture";
import { createPanelProcessSpawner } from "./panelProcess";
import { createProgramProcessSpawner } from "./programProcess";
import { memoryPressureStandIn, readResourceMemory } from "./resourceMemory";
import { createSecretRecoveryDialogs } from "./secretRecoveryDialogs";
import { createSetAsideProcessSpawner } from "./setAsideProcess";
import { createSqlProcessSpawner } from "./sqlProcess";
import { createTaskBrowserHost } from "./taskBrowser";

/**
 * The Electron implementation of the host seam. This module is the only
 * place the shell's effects - the browser, Notification Center, the login
 * item, the dock, the Keychain read - are wired to the core.
 */

export type ElectronHostOptions = {
  /** The frame realm's library this build made (`HostCapabilities.frameLib`). */
  frameLib?: HostCapabilities["frameLib"];
  /** Settle running work before Squirrel replaces and restarts this app. */
  prepareUpdateRestart?: () => Promise<void>;
  /**
   * What starts this program again once its own update replaced it, in
   * place of quitting and reopening it: Infinitary started by a command
   * ends for its starter to start the new copy (docs/run.md, "After an update").
   */
  relaunch?: (execPath?: string) => void;
  /** Opens this computer's window beside a first mate a command started (`HostCapabilities.openOwnWindow`). */
  openOwnWindow?: () => void;
  /** The window's installed keys (`HostCapabilities.installedKeys`); null or absent with no window open. */
  installedKeys?: HostCapabilities["installedKeys"];
  /** Explicit protected capability, also the isolated launcher's injection seam; absent means off. */
  secrets?: HostCapabilities["secrets"];
  /**
   * Set for dev/e2e runs against an isolated userData dir. Those windows
   * stay hidden and unfocused, so notifications are suppressed entirely
   * rather than pinging the captain's desktop mid-suite.
   */
  isolatedUserDataDir?: string | undefined;
  /** The built disposable Keychain reader entry; no native access runs in main. */
  keychainProcessPath?: string | undefined;
  /** The built `sqlProcess` entry: the query process behind the `sql` read. */
  sqlProcessPath?: string | undefined;
  recordProcessPath?: string | undefined;
  /** The built `axiProcess` entry: the process that runs one task command. */
  axiProcessPath?: string | undefined;
  /** The built `programProcess` entry: the process that runs one program's script. */
  programProcessPath?: string | undefined;
  /** The built `panelProcess` entry: the process that runs one panel's background module. */
  panelProcessPath?: string | undefined;
  /** The built `setAsideProcess` entry: the process one file the files command copies is set aside in. */
  setAsideProcessPath?: string | undefined;
  /** The Linux autostart entry's name: this run's data folder's name (`startAtLoginFor`). */
  autostartName?: string | undefined;
  /** A run from source on the person's own data folder (`HostAppInfo.sourceOnOwnData`). */
  sourceOnOwnData?: boolean | undefined;
  /**
   * Opens the window again where closing it kept Firstmate working with
   * none (./trayIcon.ts): a notification's click reopens it.
   */
  openWindow?: (() => void) | undefined;
};

/**
 * This app's autostart entry on a Linux desktop (./autostartEntry.ts): one
 * per data folder, named as that folder is, starting this AppImage, this
 * installed program, or in development Electron with this app.
 */
function autostartEntry(name: string): AutostartEntry {
  return {
    configDir: app.getPath("appData"),
    name,
    exec: app.isPackaged
      ? [process.env.APPIMAGE || process.execPath]
      : [process.execPath, app.getAppPath()],
  };
}

/** The entry's name when the caller names none: this build's own folder for its flavor. */
function ownAutostartName(): string {
  const release =
    app.isPackaged && packagedFlavor(readPackageJsonAt(app.getAppPath())) === "release";
  return userDataFolderFor(release ? "release" : "dev");
}

/**
 * Start at login (docs/architecture.md, "Desktop platform facts"): a native
 * login item where Electron has one, and on Linux the autostart entry named
 * `autostartName`.
 */
export function startAtLoginFor(autostartName: string): {
  get: () => boolean;
  set: (enabled: boolean) => void;
} {
  // Windows keeps the login item as a command line under the app's name, so
  // a development run names Electron and the checkout it loads, and the item
  // is read back by the same line (docs/architecture.md, "Desktop platform facts").
  const windows = hostPlatform() === "win32";
  const line = windows
    ? { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }
    : {};
  return {
    get: () =>
      hostPlatformProfile().nativeLoginItem
        ? app.getLoginItemSettings(line).openAtLogin
        : hostDesktop().autostartEntry && readAutostart(autostartEntry(autostartName)),
    set: (enabled) => {
      if (hostPlatformProfile().nativeLoginItem)
        app.setLoginItemSettings({ openAtLogin: enabled, ...line });
      else if (hostDesktop().autostartEntry) writeAutostart(autostartEntry(autostartName), enabled);
    },
  };
}

/**
 * Removes another app's Linux autostart entry by its name: after the
 * one-time move, Firstmate 3000's entry would start the program that now is
 * Infinitary a second time at login (src/main/handOver.ts).
 */
export function forgetAutostart(name: string): void {
  if (hostDesktop().autostartEntry) writeAutostart(autostartEntry(name), false);
}

/** Presence (D-17): dock on by default; off keeps the window-only presence. */
export function applyDockVisibility(showInDock: boolean): void {
  if (hostPlatform() !== "darwin" || !app.dock) return;
  if (showInDock) {
    void app.dock.show();
  } else {
    app.dock.hide();
  }
}

/** The notifications on screen, the newest for each card, held so each still hears its click. */
const shownNotifications = new Map<string, Notification>();

export function createElectronHost(options: ElectronHostOptions = {}): HostCapabilities {
  const {
    isolatedUserDataDir,
    keychainProcessPath,
    sqlProcessPath,
    recordProcessPath,
    axiProcessPath,
    programProcessPath,
    panelProcessPath,
    setAsideProcessPath,
    openWindow,
  } = options;
  const startAtLogin = startAtLoginFor(options.autostartName ?? ownAutostartName());
  return {
    ...(options.secrets
      ? {
          secrets: {
            ...options.secrets,
            ...(!options.secrets.recovery && !isolatedUserDataDir
              ? { recovery: createSecretRecoveryDialogs() }
              : {}),
          },
        }
      : {}),
    app: {
      version: app.getVersion(),
      platform: hostPlatform(),
      packaged: app.isPackaged,
      userDataDir: app.getPath("userData"),
      appDir: app.getAppPath(),
      resourcesDir: process.resourcesPath,
      flavor: app.isPackaged ? packagedFlavor(readPackageJsonAt(app.getAppPath())) : "dev",
      ...(options.sourceOnOwnData ? { sourceOnOwnData: true } : {}),
    },
    ...(options.frameLib ? { frameLib: options.frameLib } : {}),
    openExternal: (url) => shell.openExternal(url),
    temporaryDir: () => app.getPath("temp"),
    ...(hostPlatform() === "darwin" &&
    app.isPackaged &&
    !isolatedUserDataDir &&
    packagedFlavor(readPackageJsonAt(app.getAppPath())) === "release" &&
    options.prepareUpdateRestart
      ? { macUpdates: createMacUpdateDriver(options.prepareUpdateRestart) }
      : {}),
    // A development or test run may stand in a direct copy's update (macUpdateStandIn.ts).
    ...(() => {
      const standIn = macUpdateStandIn(process.env, app.isPackaged);
      return standIn ? { macUpdates: standIn } : {};
    })(),
    ...(options.openOwnWindow ? { openOwnWindow: options.openOwnWindow } : {}),
    ...(options.installedKeys ? { installedKeys: options.installedKeys } : {}),
    // An isolated run is started from outside, which starts it again; only a
    // person's app starts itself again.
    relaunch:
      options.relaunch ??
      ((execPath) => {
        if (!isolatedUserDataDir) app.relaunch(execPath ? { execPath, args: [] } : undefined);
        app.quit();
      }),
    // A Windows installer's hand-over opens the new copy: a window only quits,
    // and a command ends as its own update ends it, for its starter.
    endForInstaller: () => {
      if (options.relaunch) options.relaunch();
      else app.quit();
    },
    notifications: {
      supported: () => !isolatedUserDataDir && Notification.isSupported(),
      focused: () => appWindows().some((win) => win.isFocused()),
      show: ({ title, body, cardId }) => {
        const notification = new Notification({ title, body, silent: true });
        // Held until it goes, the newest for each card: a notification the
        // collector took hears no click (Windows' among them).
        const held = cardId ?? title;
        shownNotifications.set(held, notification);
        const letGo = () => {
          if (shownNotifications.get(held) === notification) shownNotifications.delete(held);
        };
        notification.on("close", letGo);
        notification.on("click", () => {
          letGo();
          // The window takes the card when told, or when the click opened it.
          if (cardId) noteNotifiedCard(cardId);
          const win = appWindows()[0];
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            if (cardId) win.webContents.send("inf:cards:notified", {});
          } else {
            openWindow?.();
          }
        });
        notification.show();
      },
    },
    presence: {
      // A native login item where Electron has one; the desktop's autostart
      // entry on Linux (docs/architecture.md, "Desktop platform facts").
      getStartAtLogin: startAtLogin.get,
      setStartAtLogin: startAtLogin.set,
      setShowInDock: applyDockVisibility,
    },
    keychain: createDesktopKeychain(keychainProcessPath, Boolean(isolatedUserDataDir)),
    capture: { capturePanel: captureDockedPanel },
    mediaProbe: createMediaProbe(),
    typefaceProbe: createTypefaceProbe(),
    resourceMemory: () => readResourceMemory(memoryPressureStandIn(process.env, app.isPackaged)),
    // Electron's private footprint, in kilobytes: macOS's phys_footprint, which
    // counts compressed and swapped memory that resident size leaves out.
    processFootprint: () =>
      process.getProcessMemoryInfo().then(
        (info) => (info.private > 0 ? info.private * 1024 : null),
        () => null,
      ),
    windowState: () => {
      const windows = appWindows();
      if (windows.length === 0) return "none";
      if (windows.some((win) => win.isFocused())) return "focused";
      if (windows.some((win) => win.isVisible() && !win.isMinimized())) return "visible";
      return "hidden";
    },
    // A page the captain holds that asks for a file gets it from the app's own
    // picker, a sheet over the app's window, never one on the page's hidden
    // window (docs/task-browser.md, "A page that asks for a file").
    browser: createTaskBrowserHost(async ({ multiple }) => {
      const owner = appWindows().find((win) => win.isFocused()) ?? appWindows()[0];
      if (!owner) return [];
      const picked = await dialog.showOpenDialog(owner, {
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
        buttonLabel: m.dialogAttach(),
      });
      return picked.canceled ? [] : picked.filePaths;
    }),
    ...(recordProcessPath ? { recordProcess: createSqlProcessSpawner(recordProcessPath) } : {}),
    ...(sqlProcessPath ? { sqlProcess: createSqlProcessSpawner(sqlProcessPath) } : {}),
    ...(axiProcessPath ? { axiProcess: createAxiProcessSpawner(axiProcessPath) } : {}),
    ...(programProcessPath
      ? { programProcess: createProgramProcessSpawner(programProcessPath) }
      : {}),
    ...(panelProcessPath ? { panelProcess: createPanelProcessSpawner(panelProcessPath) } : {}),
    ...(setAsideProcessPath
      ? { setAsideProcess: createSetAsideProcessSpawner(setAsideProcessPath) }
      : {}),
  };
}
