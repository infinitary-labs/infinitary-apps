import { settingFrom } from "@shared/envSettings";
import { type MicAccess, micAccessSchema } from "@shared/voice";
import { app, systemPreferences } from "electron";
import { hostPlatform } from "../../core/platform";

/** System Settings → Privacy & Security → Microphone. */
export const MIC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

/**
 * Whether macOS lets this app use the microphone, read without asking
 * (docs/composer.md, "Voice"). A development or e2e run stands in for
 * macOS's answer with INFINITARY_MIC_ACCESS, read on every call so a test can
 * change it the way a person changes System Settings.
 */
export function micAccess(): MicAccess {
  if (!app.isPackaged) {
    const standIn = micAccessSchema.safeParse(settingFrom(process.env, "MIC_ACCESS")?.trim());
    if (standIn.success) return standIn.data;
  }
  if (hostPlatform() !== "darwin") return "unknown";
  return systemPreferences.getMediaAccessStatus("microphone");
}
