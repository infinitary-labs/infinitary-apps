import type { DeviceChip, DeviceSystem } from "./devices";
import type { DictationKey } from "./dictation";

/** Desktop facts shared by host adapters; words, keys and installers extend this profile. */
export type PlatformProfile = {
  platform: string;
  mac: boolean;
  windows: boolean;
  loginShell: string;
  nativeLoginItem: boolean;
  /**
   * The system a device on this platform says it runs (docs/devices.md,
   * "What a device is"); null on a platform the device record has no word for.
   */
  system: DeviceSystem | null;
};

export function platformProfile(platform: string): PlatformProfile {
  return {
    platform,
    mac: platform === "darwin",
    windows: platform === "win32",
    loginShell: platform === "darwin" ? "/bin/zsh" : "/bin/sh",
    nativeLoginItem: platform === "darwin" || platform === "win32",
    system: SYSTEMS[platform] ?? null,
  };
}

const SYSTEMS: Partial<Record<string, DeviceSystem>> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};

/** The chip a device on this architecture says it runs on; null for one the record has no word for. */
export function deviceChipOf(arch: string): DeviceChip | null {
  return arch === "arm64" || arch === "x64" ? arch : null;
}

/**
 * Which key holds the command role in the app's keys (docs/keyboard.md,
 * "Keys on each system"): ⌘ on a Mac, Ctrl on every other desktop.
 */
export type KeySystem = "mac" | "ctrl";

/**
 * How this desktop's own conventions shape the window (design skill readme,
 * "Linux desktop conventions"; docs/architecture.md, "Desktop platform
 * facts"). A Mac keeps every one of today's: ⌘ keys, the system's window
 * buttons inset at the top bar's left, the Dock, the translucent material
 * and right ⌥ for dictation.
 */
export type DesktopConventions = {
  keys: KeySystem;
  /** Who draws the window's buttons: the system, inset at the top bar's left, or the app, at its right. */
  windowControls: "system" | "app";
  /** Closing the last window keeps Firstmate working, with an icon in the desktop's top bar that opens it again. */
  closeToIcon: boolean;
  /** Start at login writes the desktop's autostart entry rather than a native login item. */
  autostartEntry: boolean;
  /** A Dock to show the app in or not, so Settings offers Show in dock. */
  dock: boolean;
  /** The shown window can be the system's translucent material, so Settings offers Window wash. */
  material: boolean;
  /** The dictation key until the person picks another. */
  dictationKey: DictationKey;
};

/**
 * Linux's conventions, which Windows shares where it has them; a desktop
 * the app has none for keeps a Mac's, today's.
 */
export function desktopConventions(platform: string): DesktopConventions {
  const ctrl = platform === "linux" || platform === "win32";
  return {
    keys: ctrl ? "ctrl" : "mac",
    windowControls: ctrl ? "app" : "system",
    closeToIcon: ctrl,
    autostartEntry: platform === "linux",
    dock: !ctrl,
    material: !ctrl,
    // Right Alt types accented letters on many keyboards outside a Mac.
    dictationKey: ctrl ? "ControlRight" : "AltRight",
  };
}

/**
 * How the main process tells a window's page which desktop it is on: an
 * argument its preload reads before the first paint, marked on the
 * document as `data-platform`, as the window's material is
 * (src/shared/windowMaterial.ts).
 */
export const PLATFORM_ARG = "--fm-platform=";
export const PLATFORM_ATTRIBUTE = "data-platform";

export function platformArgument(platform: string): string {
  return `${PLATFORM_ARG}${platform}`;
}

export function platformFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((entry) => entry.startsWith(PLATFORM_ARG));
  const platform = arg?.slice(PLATFORM_ARG.length);
  return platform && /^[a-z0-9]+$/.test(platform) ? platform : null;
}
