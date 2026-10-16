import type { DeviceChip, DeviceSystem } from "@shared/devices";
import { desktopConventions, deviceChipOf, platformProfile } from "@shared/platform";

/** The sole reader of the process's platform; adapters can take an explicit profile in tests. */
export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

export function hostPlatformProfile() {
  return platformProfile(hostPlatform());
}

/** This desktop's conventions (src/shared/platform.ts, `desktopConventions`). */
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
