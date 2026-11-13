import * as m from "@shared/i18n/messages.generated";
/** What Settings -> Projects says each place does with its sign-in where projects live (`DeviceForgeRows.tsx`). */

export const DEVICE_FORGE_WORDS = {
  /** What this Mac's own row says once computers sign in beside it. */
  get thisMacRole() {
    return m.settingsForgeThisMacRole();
  },
  /** What a computer's row says it does with its own sign-in, after where it runs. */
  get deviceRole() {
    return m.settingsForgeDeviceRole();
  },
} as const;
