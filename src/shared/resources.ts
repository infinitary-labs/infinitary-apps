import { z } from "zod";
import { keptJobOrders } from "./keptJobs";
import { leftBehindOrders } from "./leftoverPrograms";
import { computerLoadReadingSchema, loadOrders } from "./load";
import type { PanelComputerResourceReading, PanelComputerResources } from "./personal/contracts";

/** Resource facts are observations, never a promise or an enforced process limit. */
export const RESOURCE_SAMPLE_MS = 250;
export const RESOURCE_MAX_SAMPLE_MS = 5_000;
export const RESOURCE_MAX_AGE_MS = 10_000;
export const RESOURCE_READ_TIMEOUT_MS = 5_000;
export const RESOURCE_OBSERVATIONS_SINCE = "6.3.0";
export const RESOURCE_ORDER = "inf:computer:resources";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** macOS `kern.memorystatus_vm_pressure_level`. The one memory figure counts inactive memory only while this is normal. */
export const macMemoryPressureSchema = z.enum(["normal", "warning", "critical"]);
export type MacMemoryPressure = z.infer<typeof macMemoryPressureSchema>;
export const resourceMemorySchema = z.object({
  totalBytes: bytes.positive(),
  /** Swap occupancy, not part of installed memory or the placement allowance. */
  swapUsedBytes: bytes.optional(),
  freeBytes: bytes,
  /** Linux MemAvailable. A reading with this is Linux to the one memory figure. */
  availableBytes: bytes.optional(),
  /** macOS facts. A reading with either of these is a Mac to the one memory figure. */
  purgeableBytes: bytes.optional(),
  fileBackedBytes: bytes.optional(),
  /** macOS inactive and speculative pages. Absent on Linux, an older computer, or a failed read. */
  inactiveBytes: bytes.optional(),
  speculativeBytes: bytes.optional(),
  /** Absent when macOS did not report a pressure level with this sample. */
  memoryPressure: macMemoryPressureSchema.optional(),
});
export type ResourceMemory = z.infer<typeof resourceMemorySchema>;

const processShareSchema = z.object({
  processCount: z.number().int().nonnegative(),
  residentBytes: bytes,
  /** Processor equivalents from cumulative process-time deltas; omitted for new/unreadable processes. */
  cpuCores: z.number().nonnegative().optional(),
});
export const processResourcesSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("sampled"),
    processCount: z.number().int().nonnegative(),
    tasks: z.array(processShareSchema.extend({ taskId: z.string().min(1) })),
    other: processShareSchema,
  }),
  z.object({ status: z.literal("unknown") }),
]);
export type ProcessResources = z.infer<typeof processResourcesSchema>;

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
  /** Absent on older computers. Process identifiers never cross the connection. */
  processes: processResourcesSchema.optional(),
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
    /**
     * Installed memory the home counts as used, once, by Automatic's rule.
     * Absent when the reading has no figure. At most `totalBytes`
     * (`validMemoryUsedBytes`).
     */
    memoryUsedBytes: bytes.optional(),
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
      load: computerLoadReadingSchema.optional(),
    }),
  ),
}) satisfies z.ZodType<PanelComputerResources>;
export type ComputerResourcesView = z.infer<typeof computerResourcesSchema>;

// Subscribers renew demand, not sampling: only the core owns the shared loop.
export const RESOURCE_REFRESH_MS = 2_000;
export const RESOURCE_DEMAND_RENEW_MS = 5_000;
export const RESOURCE_DEMAND_LEASE_MS = 15_000;

/** Computer facts, declared-run admission and kept jobs' own commands; none loads accounts or opens a conversation. */
export const resourceOrders = {
  ...loadOrders,
  ...leftBehindOrders,
  ...keptJobOrders,
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

/** The one memory figure, when present, is a whole number of bytes at most installed memory. */
export function validMemoryUsedBytes(
  totalBytes: number,
  memoryUsedBytes: number | undefined,
): boolean {
  return (
    memoryUsedBytes === undefined ||
    (Number.isSafeInteger(memoryUsedBytes) && memoryUsedBytes >= 0 && memoryUsedBytes <= totalBytes)
  );
}

/**
 * What a panel is given for `computers.resources`: installed memory, the one
 * figure and Mac pressure. The raw counts stay on the published reading and
 * never reach a panel, so a panel cannot compute its own RAM used.
 */
export function panelComputerResources(view: ComputerResourcesView): PanelComputerResources {
  return {
    computers: view.computers.map((computer) => ({
      computerId: computer.computerId,
      label: computer.label,
      reading: panelReading(computer.reading),
    })),
  };
}

function panelReading(reading: ComputerResourceReading): PanelComputerResourceReading {
  if (reading.status !== "fresh") return reading;
  const { memoryPressure } = reading.observation.memory;
  return {
    status: "fresh",
    ageMs: reading.ageMs,
    ...(reading.memoryUsedBytes === undefined ? {} : { memoryUsedBytes: reading.memoryUsedBytes }),
    observation: {
      status: "sampled",
      epoch: reading.observation.epoch,
      sequence: reading.observation.sequence,
      sampleMs: reading.observation.sampleMs,
      cpu: {
        logicalCpus: reading.observation.cpu.logicalCpus,
        idleFraction: reading.observation.cpu.idleFraction,
      },
      memory: {
        totalBytes: reading.observation.memory.totalBytes,
        ...(memoryPressure === undefined ? {} : { memoryPressure }),
      },
    },
  };
}

/** The task record and pressure notice use the same literal, unit-labelled facts. */
export function taskResourceWords(share: {
  cpuCores?: number;
  residentBytes: number;
  processCount: number;
}): string {
  const used = share.cpuCores?.toFixed(2);
  const cpu =
    used === undefined
      ? "Processor use unavailable"
      : `${used} ${used === "1.00" ? "processor" : "processors"}`;
  const memory =
    share.residentBytes >= 1024 ** 3
      ? `${(share.residentBytes / 1024 ** 3).toFixed(2)} GB resident`
      : `${(share.residentBytes / 1024 ** 2).toFixed(1)} MB resident`;
  return `${cpu} · ${memory} · ${share.processCount} ${share.processCount === 1 ? "process" : "processes"}`;
}

export const TASK_USE_UNAVAILABLE = "Use unavailable";
export const TASK_USE_EMPTY = "No processes running for this task";
