import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences, type Theme } from "@shared/preferences";
import { setInstalledKeymap } from "../design/core/installedKeys";
import { createPanelSlot } from "../plugins/createPanelSlotStore";
import { railStore } from "../plugins/railStore";
import { useShellStore } from "./store";

/**
 * The renderer's side of the persisted preferences (src/shared/preferences.ts):
 * read them from the core once, apply them, let each surface write its own
 * change through, and apply every push the core sends back - because since
 * talk-to-personalize Step 1 the Firstmate writes them too ("switch to
 * light", "hide tasks"), and the window has to follow without a relaunch.
 */

/** The one writer of the theme attribute the token files key off. */
export function applyTheme(theme: Theme): void {
  document.body.dataset.theme = theme;
}

/**
 * Applies the core's value to the window: the look through the shell
 * store's one appearance writer (seeded, not chosen - `setTheme` would write
 * it straight back and loop), the theme on the body as the store then holds
 * it, the layout on the rail store, the panels switch on the
 * create-your-own-panel slot's facts. Idempotent, so the push that echoes a
 * change this window made lands as a no-op, and one that arrives while
 * the window's own writes are unanswered gives way to their answer.
 */
export function applyPreferences(preferences: ShellPreferences): void {
  useShellStore.getState().applyAppearance(preferences.appearance);
  applyTheme(useShellStore.getState().theme);
  railStore.hydrate(preferences.layout);
  createPanelSlot.notePanelsOn(preferences.panels.enabled);
}

/**
 * Adopt the captain's persisted choices before the first render, then keep
 * following them. Reading them here, rather than letting each surface fetch
 * its own on mount, is what keeps the app from painting a default it is
 * about to replace - a light-theme window never flashes dark, and a
 * collapsed panel never flashes open.
 *
 * A core that cannot answer leaves the defaults in place: preferences are
 * never the reason the app fails to start.
 */
export async function hydratePreferences(): Promise<void> {
  let preferences: ShellPreferences = DEFAULT_SHELL_PREFERENCES;
  const keymap = hydrateKeymap();
  try {
    preferences = await window.infinitary.settings.getPreferences();
  } catch {
    // No core to ask, or an older one: the defaults above are the answer,
    // and this never rejects, because the first render waits on it.
  }
  applyPreferences(preferences);
  try {
    window.infinitary.settings.onPreferences(applyPreferences);
  } catch {
    // Without a push the window keeps what it read; its own writes still apply locally.
  }
  await keymap;
}

/**
 * The window's installed keys (docs/keyboard.md), read before the first
 * render so no hint shows a key the window does not take, then followed.
 * A main process that cannot answer leaves the catalog's keys.
 */
async function hydrateKeymap(): Promise<void> {
  try {
    window.infinitary.keyboard.onKeymap(setInstalledKeymap);
    setInstalledKeymap(await window.infinitary.keyboard.keymap());
  } catch {
    // The catalog's keys stand in; never the reason the window fails to start.
  }
}
