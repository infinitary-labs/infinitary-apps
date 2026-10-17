import { z } from "zod";
import type { PanelComputerResources } from "./personal/contracts";

/** Resource facts are observations, never a promise or an enforced process limit. */
export const RESOURCE_SAMPLE_MS = 250;
export const RESOURCE_MAX_SAMPLE_MS = 5_000;
export const RESOURCE_MAX_AGE_MS = 10_000;
export const RESOURCE_READ_TIMEOUT_MS = 5_000;
export const RESOURCE_OBSERVATIONS_SINCE = "6.3.0";
export const RESOURCE_ORDER = "inf:computer:resources";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** macOS `kern.memorystatus_vm_pressure_level`: normal counts inactive memory, the others do not. */
export const macMemoryPressureSchema = z.enum(["normal", "warning", "critical"]);
export type MacMemoryPressure = z.infer<typeof macMemoryPressureSchema>;
export const resourceMemorySchema = z.object({
  totalBytes: bytes.positive(),
  freeBytes: bytes,
  /** Linux MemAvailable; absent where the system supplies no such estimate. */
  availableBytes: bytes.optional(),
  /** macOS facts kept separately: none of these is added to free memory here. */
  purgeableBytes: bytes.optional(),
  fileBackedBytes: bytes.optional(),
  /** macOS inactive and speculative pages. Absent on Linux, an older computer, or a failed read. */
  inactiveBytes: bytes.optional(),
  speculativeBytes: bytes.optional(),
  /** Absent when macOS did not report a pressure level with this sample. */
  memoryPressure: macMemoryPressureSchema.optional(),
});
export type ResourceMemory = z.infer<typeof resourceMemorySchema>;

const stamp = {
  /** One sampler lifetime; no host clock or permanent hardware identifier crosses. */
  epoch: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const sampledResourceObservationSchema = z.object({
  ...stamp,
  status: z.literal("sampled"),
  sampleMs: z.number().min(RESOURCE_SAMPLE_MS).max(RESOURCE_MAX_SAMPLE_MS),
  cpu: z.object({
    logicalCpus: z.number().int().positive().max(65_536),
    /** Mean idle share over a CPU-time delta, not a load average. */
    idleFraction: z.number().min(0).max(1),
  }),
  memory: resourceMemorySchema,
});
export const resourceObservationSchema = z.discriminatedUnion("status", [
  sampledResourceObservationSchema,
  z.object({
    ...stamp,
    status: z.literal("unknown"),
    reason: z.enum(["unavailable", "interrupted"]),
  }),
]);
export type ResourceObservation = z.infer<typeof resourceObservationSchema>;

/** Receiver-owned freshness, shared by placement, screens and personal panels. */
export const computerResourceReadingSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("fresh"),
    observation: sampledResourceObservationSchema,
    ageMs: z.number().nonnegative().max(RESOURCE_MAX_AGE_MS),
  }),
  z.object({
    status: z.literal("unknown"),
    reason: z.enum([
      "missing",
      "stale",
      "out-of-reach",
      "unsupported",
      "unavailable",
      "invalid",
      "timeout",
    ]),
  }),
]);
export type ComputerResourceReading = z.infer<typeof computerResourceReadingSchema>;

/** A current reading for each work computer, including this home as null. */
export const computerResourcesSchema = z.object({
  computers: z.array(
    z.object({
      computerId: z.string().min(1).max(128).nullable(),
      label: z.string().min(1).max(256),
      reading: computerResourceReadingSchema,
    }),
  ),
}) satisfies z.ZodType<PanelComputerResources>;
export type ComputerResourcesView = z.infer<typeof computerResourcesSchema>;

// Subscribers renew demand, not sampling: only the core owns the shared loop.
export const RESOURCE_REFRESH_MS = 2_000;
export const RESOURCE_DEMAND_RENEW_MS = 5_000;
export const RESOURCE_DEMAND_LEASE_MS = 15_000;

/** A read-only order, answered without loading accounts or opening any conversation. */
export const resourceOrders = {
  [RESOURCE_ORDER]: {
    effect: "read",
    request: z.tuple([]),
    response: resourceObservationSchema,
  },
} as const;

/** Cross-field bounds supplement the published shape, at both ends of the connection. */
export function validResourceMemory(memory: ResourceMemory): boolean {
  return (
    resourceMemorySchema.safeParse(memory).success &&
    [
      memory.freeBytes,
      memory.availableBytes,
      memory.purgeableBytes,
      memory.fileBackedBytes,
      memory.inactiveBytes,
      memory.speculativeBytes,
    ].every((value) => value === undefined || value <= memory.totalBytes)
  );
}
