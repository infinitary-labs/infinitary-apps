/// <reference types="vite/client" />
/// <reference types="electron-vite/node" />
import { onLanguageChange } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import { app, Menu, nativeImage, Tray } from "electron";
import trayIconPath from "./assets/trayIcon.png?asset";

/**
 * Closing the window keeps Firstmate working on a desktop with no Dock
 * (design skill readme, "Linux desktop conventions"): the app's icon stays
 * in the desktop's top bar while Firstmate runs, and pressing it opens the
 * window again. Its menu holds Open Infinitary and Quit Infinitary, worded
 * in the app's language and again when it changes.
 * The mark is the app icon's, rendered by scripts/render-tray-icon.mjs.
 *
 * Build-time only, like ./frames/fontFiles.ts: `?asset` needs
 * electron-vite's plugin, so nothing unit-tested imports this module.
 */

let shown: Tray | null = null;

export function showTrayIcon(open: () => void): void {
  if (shown) return;
  const tray = new Tray(nativeImage.createFromPath(trayIconPath));
  tray.setToolTip("Infinitary");
  const worded = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: m.trayOpen(), click: open },
        { type: "separator" },
        { label: m.trayQuit(), click: () => app.quit() },
      ]),
    );
  worded();
  onLanguageChange(worded);
  tray.on("click", open);
  shown = tray;
}
