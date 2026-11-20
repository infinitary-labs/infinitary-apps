import type { ThisMac } from "@shared/devices";
import type { SettingsShow } from "@shared/showActions";
import { showsSection } from "../../devices/viewWords";
import { pluginHost } from "../host";

/**
 * The one way a place in Settings is opened by name (docs/ui-plugins.md,
 * "Opening Settings"; primitives/app-actions.md, "Pointing"): a panel's
 * `point.openSettings` and the first mate's `show-settings` both open only
 * a section this window offers now - registered, shown on this kind of
 * window (`showsSection`), and with its own gate open, as the Settings
 * screen lists it. One it does not offer opens nothing, never another tab.
 */
export async function offersSettingsSection(
  section: string,
  thisMac: ThisMac | null,
): Promise<boolean> {
  const offered = pluginHost.settingsSections.get(section);
  if (!offered || !showsSection(thisMac, offered)) return false;
  const gate = offered.enabled;
  if (!gate) return true;
  return Promise.resolve()
    .then(() => gate())
    .catch(() => false);
}

let latestPointing = 0;

/**
 * A pointing at a place begins (the first mate's show-task or show-settings,
 * a panel's point.openRecord or point.openSettings): the answer says whether
 * it is still the newest when its own checks finish, so a slow check never
 * moves the window after a later pointing has.
 */
export function beginPointing(): () => boolean {
  latestPointing += 1;
  const mine = latestPointing;
  return () => mine === latestPointing;
}

/** The window's state that opens Settings on a section, with what it shows on arrival. */
export function settingsPlaceState(place: SettingsShow) {
  return {
    view: "settings" as const,
    settingsSection: place.section,
    settingsItem: place.item === undefined ? null : { section: place.section, item: place.item },
  };
}
