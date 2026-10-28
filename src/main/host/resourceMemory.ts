import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import {
  type MacMemoryPressure,
  type ResourceMemory,
  validResourceMemory,
} from "@shared/resources";

const execFileAsync = promisify(execFile);
/** Both reads finished in under 10 ms on the Mac this rule was measured on. */
const MAC_READ_MS = 1_000;
const MAC_READ_BYTES = 64 * 1024;

/** Inactive and speculative bytes from one `vm_stat` text, or nothing it does not say. */
export function macPagesFromVmStat(
  text: string,
): { inactiveBytes: number; speculativeBytes: number } | null {
  const page = /page size of (\d+) bytes/.exec(text);
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(text);
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(text);
  if (!page || !inactive || !speculative) return null;
  const pageSize = Number(page[1]);
  const inactivePages = Number(inactive[1]);
  const speculativePages = Number(speculative[1]);
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 1024 * 1024) return null;
  if (!Number.isInteger(inactivePages) || inactivePages < 0) return null;
  if (!Number.isInteger(speculativePages) || speculativePages < 0) return null;
  const inactiveBytes = inactivePages * pageSize;
  const speculativeBytes = speculativePages * pageSize;
  if (!Number.isSafeInteger(inactiveBytes) || !Number.isSafeInteger(speculativeBytes)) return null;
  return { inactiveBytes, speculativeBytes };
}

/**
 * `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical.
 * Any other reported level is not normal, so inactive memory does not count.
 */
export function macPressureFromSysctl(text: string): MacMemoryPressure | null {
  const value = Number(text.trim());
  if (value === 1) return "normal";
  if (value === 2) return "warning";
  if (Number.isInteger(value) && value > 0) return "critical";
  return null;
}

/** `vm.swapusage` reports occupancy independently of installed memory. */
export function macSwapFromSysctl(text: string): number | undefined {
  const match = /used\s*=\s*([\d.]+)([KMG])/.exec(text);
  if (!match) return undefined;
  const bytes =
    Number(match[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2] ?? ""] ?? Number.NaN);
  return Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : undefined;
}

/** Linux /proc/meminfo reports KiB; a failed read omits only swap. */
export function linuxSwapFromMeminfo(text: string): number | undefined {
  const total = /^SwapTotal:\s+(\d+) kB$/m.exec(text);
  const free = /^SwapFree:\s+(\d+) kB$/m.exec(text);
  if (!total || !free) return undefined;
  const used = (Number(total[1]) - Number(free[1])) * 1024;
  return Number.isSafeInteger(used) && used >= 0 ? used : undefined;
}

async function readLinuxSwap(): Promise<number | undefined> {
  try {
    return linuxSwapFromMeminfo(await readFile("/proc/meminfo", "utf8"));
  } catch {
    return undefined;
  }
}

export type MacMemoryFacts = {
  swapUsedBytes?: number;
  inactiveBytes?: number;
  speculativeBytes?: number;
  memoryPressure?: MacMemoryPressure;
};

/** Keep a failed or oversized Mac read from discarding Electron's facts. */
export function withMacMemoryFacts(
  base: ResourceMemory,
  facts: MacMemoryFacts | null,
): ResourceMemory {
  if (!facts) return base;
  const reading: ResourceMemory = { ...base, ...facts };
  if (validResourceMemory(reading)) return reading;
  if (!facts.memoryPressure) return base;
  const pressureOnly: ResourceMemory = { ...base, memoryPressure: facts.memoryPressure };
  return validResourceMemory(pressureOnly) ? pressureOnly : base;
}

async function readText(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: MAC_READ_MS,
      maxBuffer: MAC_READ_BYTES,
      env: hostEnv(),
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Fresh inactive pages and pressure. A miss is omitted facts, never a failed sample. */
export async function readMacMemoryFacts(): Promise<MacMemoryFacts | null> {
  if (hostPlatform() !== "darwin") return null;
  const [pagesText, pressureText, swapText] = await Promise.all([
    readText("/usr/bin/vm_stat", []),
    readText("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    readText("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
  ]);
  const pages = pagesText ? macPagesFromVmStat(pagesText) : null;
  const memoryPressure = pressureText ? macPressureFromSysctl(pressureText) : null;
  const swapUsedBytes = swapText ? macSwapFromSysctl(swapText) : undefined;
  if (!pages && !memoryPressure && swapUsedBytes === undefined) return null;
  return {
    ...(swapUsedBytes === undefined ? {} : { swapUsedBytes }),
    ...pages,
    ...(memoryPressure ? { memoryPressure } : {}),
  };
}

/** Electron reports KiB, not bytes. Keep unlike OS estimates unlike. */
export async function readResourceMemory(): Promise<ResourceMemory | null> {
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
    if (!validResourceMemory(reading)) return null;
    if (platform !== "darwin") {
      const swapUsedBytes = await readLinuxSwap();
      return { ...reading, ...(swapUsedBytes === undefined ? {} : { swapUsedBytes }) };
    }
    return withMacMemoryFacts(reading, await readMacMemoryFacts());
  } catch {
    return null;
  }
}
