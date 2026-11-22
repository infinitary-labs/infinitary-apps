import { type BrowserWindow, powerMonitor, systemPreferences } from "electron";
import { hostPlatform } from "../core/platform";
import { PresenceWatch } from "./presenceWatch";
import { watchWindowsDisplay } from "./windowsDisplay";

/**
 * Whether someone is at this computer (docs/ambient-music.md, "When nobody
 * is at the computer"), from what the system tells the app (./presenceWatch.ts).
 * A Mac and a Windows PC say it; a Linux desktop says none of it through
 * Electron, so there nobody is ever away and `watched` is false.
 */
let watch: PresenceWatch | null = null;

export function presenceWatch(): PresenceWatch {
  if (watch) return watch;
  const platform = hostPlatform();
  const started = new PresenceWatch(platform === "darwin" || platform === "win32");
  watch = started;
  if (!started.watched) return started;
  powerMonitor.on("lock-screen", () => started.set("locked", true));
  powerMonitor.on("unlock-screen", () => started.set("locked", false));
  if (platform === "darwin") {
    // Fast user switching: another person's session took the screen.
    powerMonitor.on("user-did-resign-active", () => started.set("other-session", true));
    powerMonitor.on("user-did-become-active", () => started.set("other-session", false));
    systemPreferences.subscribeWorkspaceNotification("NSWorkspaceScreensDidSleepNotification", () =>
      started.set("screen-off", true),
    );
    systemPreferences.subscribeWorkspaceNotification("NSWorkspaceScreensDidWakeNotification", () =>
      started.set("screen-off", false),
    );
    // Not in Apple's documents, though long posted by the screen saver.
    systemPreferences.subscribeNotification("com.apple.screensaver.didstart", () =>
      started.set("screen-saver", true),
    );
    systemPreferences.subscribeNotification("com.apple.screensaver.didstop", () =>
      started.set("screen-saver", false),
    );
  }
  return started;
}

/**
 * Tells the window's page each time someone leaves this computer or comes
 * back. On Windows the display's own state reaches the app only through a
 * window, so each window also listens for it there.
 */
export function followPresence(win: BrowserWindow): void {
  const watched = presenceWatch();
  const stop = watched.listen((presence) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send("inf:window:presence", presence);
  });
  const stopDisplay =
    hostPlatform() === "win32"
      ? watchWindowsDisplay(win, (off) => watched.set("screen-off", off))
      : null;
  win.once("closed", () => {
    stop();
    stopDisplay?.();
  });
}
