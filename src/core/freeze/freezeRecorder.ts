import type { Worker } from "node:worker_threads";
import { forgeOf } from "@shared/forge";
import { type SourceIdentity, sourceIdentitySchema } from "@shared/selfSource";
import { z } from "zod";
import type { TypedWake } from "../orchestrator/wakes";
import type { VersionSummary } from "./freezeTally";
import { MemoryRecorder } from "./memoryRecorder";
import { takeWatchdog } from "./watchdog";

/**
 * The freeze recorder (docs/freeze-recorder.md; INF-2061's plan, built as
 * INF-2066). A watchdog thread beside the app's main thread notices when the
 * main thread misses its heartbeat, asks V8 once for the JavaScript call path
 * the main thread is running. It persists a start before replies, then
 * completes the same incident in a bounded local record: when, how long
 * between heartbeats, how much of that the main
 * thread's own processor time was, and the function names. It records no
 * arguments, values or text.
 */

/**
 * The main thread's heartbeat to the watchdog: a fifth of the line, so a
 * stall at the line is told from one missed beat.
 */
export const HEARTBEAT_MS = 10;
/**
 * A main thread silent this long is frozen: INF-2078's plan, the stall a
 * person feels as a missed frame or two while typing or scrolling.
 */
export const FREEZE_THRESHOLD_MS = 50;
/** The record keeps the newest lines; older ones drop, so it never grows past this. */
export const RECORD_MAX_LINES = 500;

const frameSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
  column: z.number().int(),
});

/**
 * One recorded stall. `frames` is the call path, innermost first. `uncertain`
 * says the names may not be where the time went: `waited`, the main thread
 * spent under half the stall on its own processor, so it was waiting on
 * something outside JavaScript and the pause landed after; `late`, the names
 * were read only after the stall had ended, from code that ran later.
 */
export const freezeLineSchema = z.object({
  incidentId: z.string().optional(),
  status: z.literal("completed").optional(),
  completedAt: z.string().optional(),
  at: z.string(),
  build: sourceIdentitySchema.optional(),
  wallMs: z.number().int().nonnegative(),
  cpuMs: z.number().int().nonnegative(),
  frames: z.array(frameSchema),
  // Optional for old records and captures that were never requested or received.
  captureRequestedAt: z.string().optional(),
  capturedAt: z.string().optional(),
  uncertain: z.enum(["waited", "late"]).optional(),
});
export type FreezeLine = z.infer<typeof freezeLineSchema>;

/** An unfinished stall retains capture timing, but has no measured end, processor time or frames. */
export const freezeIncidentSchema = z.union([
  freezeLineSchema,
  z.object({
    incidentId: z.string(),
    status: z.enum(["started", "interrupted"]),
    at: z.string(),
    interruptedAt: z.string().optional(),
    build: sourceIdentitySchema.optional(),
    captureRequestedAt: z.string().optional(),
    capturedAt: z.string().optional(),
  }),
]);
export type FreezeIncident = z.infer<typeof freezeIncidentSchema>;

/** Infinitary's own source, where a fix for a freeze goes. */
export const INFINITARY_SOURCE = {
  host: "github.com",
  owner: "infinitary-labs",
  name: "infinitary",
};

/**
 * The captain's project that is Infinitary's own source, by where it lives,
 * or undefined: the first mate offers a fix task only when there is one
 * (the captain's answer on INF-2061).
 */
export function infinitaryProject<T extends { id: string; name: string; origin: string | null }>(
  projects: readonly T[],
): T | undefined {
  return projects.find((project) => {
    const where = forgeOf(project.origin);
    return (
      where.host === INFINITARY_SOURCE.host &&
      where.owner?.toLowerCase() === INFINITARY_SOURCE.owner &&
      where.name?.toLowerCase() === INFINITARY_SOURCE.name
    );
  });
}

/**
 * The alpha recorder's automatic summary of one installed version's stalls,
 * every run of it on this computer, sent when the app first starts on the
 * next version (INF-3044's plan), once per version through the durable
 * inbox, independent of call path, restart or dismissal (INF-2205).
 */
export function freezeWake(
  summary: VersionSummary,
  project: { id: string; name: string },
): TypedWake {
  return {
    facts: {
      kind: "freeze-recorded",
      project: { id: project.id, name: project.name },
      summary,
    },
    once: `freeze-recorded:version:${summary.version}`,
  };
}

/**
 * What the recorder keeps its per-version tally in (`./freezeTally.ts`,
 * `FreezeTally`): a run's start, its awake time, each stall, and the
 * earlier versions taken out once recovery is done.
 */
export type TallyKeeper = {
  startRun(): void;
  ran(ms: number): void;
  add(line: FreezeIncident): void;
  takeEarlier(): VersionSummary[];
  flush(): void;
};

/** How often the recorder adds the run's awake time to the tally and writes it. */
export const TALLY_WRITE_MS = 60_000;

/**
 * The recorder's main-thread half: it takes the watchdog (`./watchdog.ts`),
 * which the app's entry armed before the app's code loaded, hands it the
 * record, beats every `HEARTBEAT_MS` with the main thread's own processor
 * time, and hands each recorded line to `onFreeze`. With `tally`, it counts
 * this run and each stall in the per-version tally, writes it every
 * `TALLY_WRITE_MS` and on stop, and once the watchdog has recovered the
 * previous runs' unfinished stalls hands every earlier version's summary
 * to `onVersionsEnded` (INF-3044). A watchdog that fails
 * stops the recorder and never the app. With `memory`, it also keeps the
 * memory reading (`./memoryRecorder.ts`), which needs no watchdog.
 */
export class FreezeRecorder {
  private worker: Worker | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private write: ReturnType<typeof setInterval> | undefined;
  /** When the run's awake time was last added to the tally, on the monotonic clock. */
  private ranUntil = 0;
  private readonly memory: MemoryRecorder | undefined;

  constructor(
    private readonly options: {
      recordPath: string;
      build?: SourceIdentity;
      onFreeze: (line: FreezeIncident) => void;
      tally?: TallyKeeper;
      onVersionsEnded?: (summaries: VersionSummary[]) => void;
      thresholdMs?: number;
      memory?: { recordPath: string; footprint?: () => Promise<number | null> };
    },
  ) {
    this.memory = options.memory
      ? new MemoryRecorder({
          recordPath: options.memory.recordPath,
          ...(options.build ? { build: options.build } : {}),
          ...(options.memory.footprint ? { footprint: options.memory.footprint } : {}),
        })
      : undefined;
  }

  start(): void {
    this.memory?.start();
    if (this.worker) return;
    const tally = this.options.tally;
    const versionsEnded = () => {
      if (!tally) return;
      const ended = tally.takeEarlier();
      if (ended.length) this.options.onVersionsEnded?.(ended);
    };
    if (tally && !this.write) {
      tally.startRun();
      tally.flush();
      this.ranUntil = performance.now();
      this.write = setInterval(() => {
        this.addRunning();
        tally.flush();
      }, TALLY_WRITE_MS);
      this.write.unref();
    }
    const worker = takeWatchdog();
    if (!worker) {
      versionsEnded();
      return;
    }
    this.worker = worker;
    worker.on("message", (message: unknown) => {
      // The watchdog has handed over every unfinished stall of earlier runs.
      if (message && typeof message === "object" && "recovered" in message) {
        tally?.flush();
        versionsEnded();
        return;
      }
      const line = freezeIncidentSchema.safeParse(message);
      if (!line.success) return;
      tally?.add(line.data);
      this.options.onFreeze(line.data);
    });
    worker.on("error", () => this.stop());
    worker.postMessage({
      record: {
        path: this.options.recordPath,
        build: this.options.build,
        thresholdMs: this.options.thresholdMs ?? FREEZE_THRESHOLD_MS,
        maxLines: RECORD_MAX_LINES,
      },
    });
    const beat = () => worker.postMessage({ cpu: process.threadCpuUsage() });
    beat();
    this.beat = setInterval(beat, HEARTBEAT_MS);
    this.beat.unref();
  }

  private addRunning(): void {
    const now = performance.now();
    this.options.tally?.ran(now - this.ranUntil);
    this.ranUntil = now;
  }

  stop(): void {
    this.memory?.stop();
    if (this.beat) clearInterval(this.beat);
    this.beat = undefined;
    if (this.write) {
      clearInterval(this.write);
      this.addRunning();
    }
    this.write = undefined;
    this.options.tally?.flush();
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }
}
