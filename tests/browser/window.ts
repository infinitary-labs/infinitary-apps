import type { FakeBridge } from "./bridge";

/**
 * Opens the real window in this test file's page: the bridge's API stands
 * where the preload puts it, then the renderer's own entry runs, exactly as
 * it does in the app. A browser test file draws one window, as a journey
 * launched one app; each file starts from a fresh page (./freshPage.ts).
 */
export async function openWindow(bridge: FakeBridge): Promise<void> {
  const api = Object.freeze(bridge.api);
  Object.defineProperty(window, "infinitary", { value: api, configurable: false });
  Object.defineProperty(window, "firstmate", { value: api, configurable: false });
  const root = document.createElement("div");
  root.id = "root";
  document.body.replaceChildren(root);
  await import("../../src/renderer/src/main");
}
