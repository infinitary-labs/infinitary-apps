import * as m from "@shared/i18n/messages.generated";

/** Settings → General's words (`GeneralTab.tsx`). */

/** What the purge row says once a purge went through: how many tasks it removed. */
export function purgedTasksText(count: number): string {
  return m.settingsGeneralTasksPurged({ count });
}

/**
 * The Your panels row (`YourPanelsRow`): its title, what it says while the
 * captain's panels may run, and why they are off after a safe-mode boot.
 */
export const YOUR_PANELS_WORDS = {
  get title() {
    return m.settingsGeneralYourPanels();
  },
  get on() {
    return m.settingsGeneralYourPanelsOn();
  },
  get safeMode() {
    return m.settingsGeneralYourPanelsSafeMode();
  },
} as const;
