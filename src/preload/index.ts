import { PLATFORM_ATTRIBUTE, platformFromArgv } from "@shared/platform";
import { WINDOW_MATERIAL_ATTRIBUTE, windowMaterialFromArgv } from "@shared/windowMaterial";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createApi } from "./api";

/**
 * The one frozen `window.infinitary` API (docs/architecture.md section 4), also
 * `window.firstmate`, its name before the Infinitary rename, built over
 * Electron's IPC (./api.ts).
 * Responses and pushed payloads from main are zod-validated before the
 * renderer sees them, completing the both-directions validation the
 * contract promises.
 */
const api = createApi(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, handler) => ipcRenderer.on(channel, handler),
    off: (channel, handler) => ipcRenderer.off(channel, handler),
  },
  { pathForFile: (file) => webUtils.getPathForFile(file) },
);

function deepFreeze<T extends object>(value: T): T {
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

// The one API under Infinitary's name, and under Firstmate 3000's beside it
// (the Infinitary rename keeps the old names readable): the same frozen
// surface twice, never a second one.
const frozen = deepFreeze(api);
contextBridge.exposeInMainWorld("infinitary", frozen);
contextBridge.exposeInMainWorld("firstmate", frozen);

// What the window is made of, on the document before the app's first
// render (docs/translucent-window.md): a translucent window's body paints
// the material tint; every other window paints the opaque void.
// The preload runs before the document element is born, so the mark set
// here is lost with it; the one set at DOMContentLoaded is the one that
// paints, and it lands before the app's first render.
// Which desktop the window is on, the same way: its keys, window controls
// and Settings rows follow it (src/shared/platform.ts). No mark is a Mac's.
const windowMaterial = windowMaterialFromArgv(process.argv);
const platform = platformFromArgv(process.argv);
const markWindowMaterial = () => {
  document.documentElement?.setAttribute(WINDOW_MATERIAL_ATTRIBUTE, windowMaterial);
  if (platform) document.documentElement?.setAttribute(PLATFORM_ATTRIBUTE, platform);
};
markWindowMaterial();
document.addEventListener("DOMContentLoaded", markWindowMaterial, { once: true });
