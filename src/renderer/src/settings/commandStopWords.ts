import * as m from "@shared/i18n/messages.generated";

/**
 * Beside Infinitary started by a command (docs/run.md, "Quit and Stop"):
 * the Settings → General row that offers Stop, since quitting closes only
 * the window, and what Start at login starts there. From the catalog
 * (docs/i18n.md): the window words each when it draws it; these are the
 * words as the process speaks them when this module loads, English for the
 * journeys that read them.
 */
export const COMMAND_STOP_WORDS = {
  title: m.settingsCommandStopTitle(),
  description: m.settingsCommandStopDescription(),
  stop: m.settingsCommandStop(),
  confirm: m.settingsCommandStopConfirm(),
  stopping: m.settingsCommandStopping(),
  failed: m.settingsCommandStopFailed(),
  startAtLogin: m.settingsCommandStartAtLogin(),
} as const;
