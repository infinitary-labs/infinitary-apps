import type { ResourceMemory } from "@shared/resources";

/**
 * Bytes of installed memory counted as used, once, by Automatic's rule.
 * A reading with `availableBytes` is Linux: used is installed memory minus
 * that estimate. A reading with purgeable or file-backed bytes is a Mac.
 * At normal pressure, free, speculative and inactive memory count as free,
 * and so do free, purgeable and file-backed bytes; the larger free part
 * wins, capped at installed memory. Warning or critical pressure counts
 * nothing as free. A Mac reading without pressure, or without inactive and
 * speculative bytes, counts free, purgeable and file-backed bytes as free.
 * Anything else has no figure.
 */
export function memoryUsedBytes(memory: ResourceMemory): number | undefined {
  if (memory.availableBytes !== undefined) {
    return clampUsed(memory.totalBytes, memory.totalBytes - memory.availableBytes);
  }
  if (memory.purgeableBytes === undefined && memory.fileBackedBytes === undefined) return undefined;
  return clampUsed(memory.totalBytes, memory.totalBytes - macFreeBytes(memory));
}

/** Free bytes Automatic counts on a Mac, capped at installed memory. */
function macFreeBytes(memory: ResourceMemory): number {
  const handedBack = Math.min(
    memory.totalBytes,
    memory.freeBytes + (memory.purgeableBytes ?? 0) + (memory.fileBackedBytes ?? 0),
  );
  if (memory.memoryPressure === "warning" || memory.memoryPressure === "critical") return 0;
  if (
    memory.memoryPressure !== "normal" ||
    memory.inactiveBytes === undefined ||
    memory.speculativeBytes === undefined
  ) {
    return handedBack;
  }
  return Math.min(
    memory.totalBytes,
    Math.max(handedBack, memory.freeBytes + memory.speculativeBytes + memory.inactiveBytes),
  );
}

function clampUsed(totalBytes: number, used: number): number {
  if (!Number.isFinite(used)) return totalBytes;
  return Math.min(totalBytes, Math.max(0, used));
}
