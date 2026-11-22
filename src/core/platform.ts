import type { DeviceChip, DeviceSystem } from "@shared/devices";
import { desktopConventions, deviceChipOf, platformProfile } from "@shared/platform";

/** The sole reader of the process's platform; adapters can take an explicit profile in tests. */
export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

export function hostPlatformProfile() {
  return platformProfile(hostPlatform());
}

/**
 * The kind of link the app makes to a folder (docs/windows.md, "The
 * installer"). On Windows it is a junction, which a standard account may
 * make: a folder symlink there needs Developer Mode or an administrator.
 * Node reads either back as a symbolic link, and removing one leaves the
 * folder it leads to in place.
 */
export function folderLinkType(): "junction" | "dir" {
  return hostPlatformProfile().windows ? "junction" : "dir";
}

export function hostDesktop() {
  return desktopConventions(hostPlatform());
}

/**
 * What this device says it is in each hello (docs/devices.md, "What a device
 * is"): its system and chip, each left out where the record has no word for it.
 */
export function thisDeviceSystem(
  platform: string = hostPlatform(),
  arch: string = process.arch,
): { system?: DeviceSystem; chip?: DeviceChip } {
  const system = platformProfile(platform).system;
  const chip = deviceChipOf(arch);
  return { ...(system ? { system } : {}), ...(chip ? { chip } : {}) };
}
