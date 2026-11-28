import { z } from "zod";

/**
 * The whole computer's memory state, as the watchdog read it on its own
 * thread (docs/freeze-recorder.md, "The system's memory"). INF-7202 found a
 * 38-minute stretch in which macOS cut the core's resident memory to a
 * quarter of its footprint and stalls rose elevenfold at the same workload,
 * and could not tell from the app's records what the system was doing then.
 *
 * On macOS: `pressure` is the kernel's memory pressure level
 * (`kern.memorystatus_vm_pressure_level`), `availablePercent` the share of
 * memory it counts as available (`kern.memorystatus_level`), and
 * `compressedBytes` what the memory compressor holds. On Linux:
 * `availablePercent` is MemAvailable over MemTotal and `pressureStall` the
 * share of the last ten seconds in which some or all tasks waited on memory
 * (`/proc/pressure/memory`). Swap is read on both. A field the system did
 * not answer is absent, never zero.
 */
export const systemMemorySchema = z.object({
  readAt: z.string(),
  pressure: z.enum(["normal", "warn", "critical"]).optional(),
  availablePercent: z.number().nonnegative().optional(),
  swapUsedBytes: z.number().int().nonnegative().optional(),
  swapTotalBytes: z.number().int().nonnegative().optional(),
  compressedBytes: z.number().int().nonnegative().optional(),
  pressureStall: z
    .object({ someAvg10: z.number().nonnegative(), fullAvg10: z.number().nonnegative() })
    .optional(),
});
export type SystemMemory = z.infer<typeof systemMemorySchema>;
