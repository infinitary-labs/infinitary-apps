import type { FrameBridgeApi } from "@shared/plugins/bridge";

/**
 * The frame realm's one way to the host (one plugin vehicle, Phase A item
 * 4): the bridge the panel document installs as `window.inf` before any
 * module runs. Everything a panel reaches - its reads, its store slice, the
 * theme - goes through it, and the host checks every request against what
 * the mount was granted; nothing in this realm can reach the app's window,
 * its IPC or another panel.
 */
export function frameBridge(target: object = globalThis): FrameBridgeApi {
  const api = (target as { inf?: FrameBridgeApi }).inf;
  if (!api) throw new Error("the frame realm runs only inside a panel document, beside its bridge");
  return api;
}
