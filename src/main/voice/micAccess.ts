import { settingFrom } from "@shared/envSettings";
import { type MicAccess, micAccessSchema } from "@shared/voice";
import { app, systemPreferences } from "electron";
import { hostPlatform } from "../../core/platform";

/** System Settings → Privacy & Security → Microphone. */
export const MIC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

/** Windows Settings → Privacy & security → Microphone. */
export const WINDOWS_MIC_SETTINGS_URL = "ms-settings:privacy-microphone";

/** The page that turns this app's microphone access on: the Mac's or Windows' own. */
export function micSettingsUrl(platform: string = hostPlatform()): string {
  return platform === "win32" ? WINDOWS_MIC_SETTINGS_URL : MIC_SETTINGS_URL;
}

/**
 * Whether macOS or Windows lets this app use the microphone, read without
 * asking (docs/composer.md, "Voice"); Windows answers from its Privacy &
 * security switches, which it never asks a person about for a desktop app.
 * A development or e2e run stands in for the system's answer with
 * INFINITARY_MIC_ACCESS, read on every call so a test can change it the way
 * a person changes System Settings.
 */
export function micAccess(): MicAccess {
  if (!app.isPackaged) {
    const standIn = micAccessSchema.safeParse(settingFrom(process.env, "MIC_ACCESS")?.trim());
    if (standIn.success) return standIn.data;
  }
  if (hostPlatform() !== "darwin" && hostPlatform() !== "win32") return "unknown";
  return systemPreferences.getMediaAccessStatus("microphone");
}
