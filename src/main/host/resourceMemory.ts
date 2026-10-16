import { hostPlatform } from "@core/platform";
import { type ResourceMemory, validResourceMemory } from "@shared/resources";

/** Electron reports KiB, not bytes. Keep unlike OS estimates unlike. */
export function readResourceMemory(): ResourceMemory | null {
  const platform = hostPlatform();
  if (platform !== "darwin" && platform !== "linux") return null;
  try {
    const memory = process.getSystemMemoryInfo();
    const reading: ResourceMemory = {
      totalBytes: memory.total * 1024,
      freeBytes: memory.free * 1024,
      ...(platform === "linux"
        ? { availableBytes: memory.available * 1024 }
        : { purgeableBytes: memory.purgeable * 1024, fileBackedBytes: memory.fileBacked * 1024 }),
    };
    return validResourceMemory(reading) ? reading : null;
  } catch {
    return null;
  }
}
