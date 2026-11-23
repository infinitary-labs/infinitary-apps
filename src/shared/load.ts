import { z } from "zod";
import { formatNumber } from "./i18n/format.ts";
import * as m from "./i18n/messages.generated.ts";

/** INF-1621: the caller declares a hold, never an estimate made by the app. */
export const loadDemandSchema = z.object({
  cpu: z.number().finite().positive(),
  memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type LoadDemand = z.infer<typeof loadDemandSchema>;

export const loadRunSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().min(1),
  demand: loadDemandSchema,
  state: z.enum(["waiting", "running"]),
  ahead: z.number().int().nonnegative(),
  reason: z.enum(["line", "capacity", "pressure", "unavailable"]).optional(),
  /** First in line and waiting for room: what the line had to give when it last compared. */
  free: z
    .object({
      cpu: z.number().finite().nonnegative(),
      memoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .optional(),
});
export type LoadRun = z.infer<typeof loadRunSchema>;
export const loadSnapshotSchema = z.object({ runs: z.array(loadRunSchema) });
export type LoadSnapshot = z.infer<typeof loadSnapshotSchema>;
/** Unknown retains last-known runs, explicitly stale, rather than implying they ended. */
export const computerLoadReadingSchema = loadSnapshotSchema.extend({
  status: z.enum(["fresh", "unknown"]),
});
export type ComputerLoadReading = z.infer<typeof computerLoadReadingSchema>;

export const LOAD_COMMAND = "infinitary-load-axi";
export const LOAD_ORDER = "inf:computer:load";
/** The authenticated home carries only overrides already recorded on its tasks. */
export const loadOrders = {
  [LOAD_ORDER]: {
    effect: "write",
    request: z.tuple([z.object({ overrides: z.array(z.string().min(1)) })]),
    response: loadSnapshotSchema,
  },
} as const;

/** Reservations and observed Use have different names: a hold is not measured memory. */
export function loadRunWords(run: LoadRun, computer: string): string {
  const demand = `${run.demand.cpu} ${run.demand.cpu === 1 ? "processor" : "processors"} · ${(run.demand.memoryBytes / 1024 ** 3).toFixed(2)} GB declared`;
  if (run.state === "running") return `Running on ${computer} · ${demand}`;
  const reason =
    run.reason === "pressure"
      ? "memory pressure"
      : run.reason === "unavailable"
        ? "readings unavailable"
        : run.reason === "capacity" && run.free
          ? m.uiTaskResourceRunFree({
              processors: run.free.cpu,
              memory: formatNumber(run.free.memoryBytes / 1024 ** 3, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            })
          : `${run.ahead} ahead`;
  return `Waiting in line to run on ${computer} · ${reason} · ${demand}`;
}
