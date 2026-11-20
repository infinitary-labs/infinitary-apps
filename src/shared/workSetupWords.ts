import { inLanguage } from "./i18n/current";
import { SOURCE_LANGUAGE } from "./i18n/languages";
import * as m from "./i18n/messages.generated";
import type { DeviceWorkSetup } from "./workSetup";

/** The Devices explanation, shared by sign-in settings and the setup card. */
export function workSetupWords(
  device: string,
  setup?: DeviceWorkSetup,
  held = false,
): string | null {
  const words = { device };
  if (held && (!setup || setup.reason === "local-network")) return m.settingsDevicesHeldLine(words);
  if (!setup) return null;
  if (setup.state === "starting") return m.settingsDevicesWorkStarting(words);
  switch (setup.reason) {
    case "other-home":
      return m.settingsDevicesWorkOtherHome(words);
    case "other-entry":
      return m.settingsDevicesWorkOtherEntry(words);
    case "removal-unfinished":
      return m.settingsDevicesWorkRemovalUnfinished(words);
    case "app-place":
      return m.settingsDevicesWorkAppPlace(words);
    case "background-off":
      return m.settingsDevicesWorkBackgroundOff(words);
    case "no-background":
      return m.settingsDevicesWorkNoBackground(words);
    case "newer-work":
      return m.settingsDevicesWorkNewerWork(words);
    default:
      return m.settingsDevicesWorkNotReached(words);
  }
}

/** The same reason for English-only tool replies and saved host cards. */
export function workSetupWordsInEnglish(...args: Parameters<typeof workSetupWords>): string | null {
  return inLanguage(SOURCE_LANGUAGE, () => workSetupWords(...args));
}

export function signInsUnansweredInEnglish(who: string, home: string): string {
  return inLanguage(SOURCE_LANGUAGE, () => m.settingsDevicesSignInsUnanswered({ who, home }));
}
