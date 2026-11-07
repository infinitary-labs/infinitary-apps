import type { Worker } from "node:worker_threads";
import { forgeOf } from "@shared/forge";
import { type SourceIdentity, sourceIdentitySchema } from "@shared/selfSource";
import { z } from "zod";
import type { TypedWake } from "../orchestrator/wakes";
import { MEMORY_READING_MS, MemoryRecorder } from "./memoryRecorder";
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
 * The stalls one recorder has handed over since it started (INF-2971's
 * first finding): a single stall told the first mate nothing about how
 * often the app hitched, so its summary carries the rate.
 */
export type StallTally = {
  /** When this recorder started: the start of this app's run. */
  since: string;
  /** When the tally was read. */
  until: string;
  /** Completed stalls, and their time between heartbeats in all. */
  stalls: number;
  stallMs: number;
  /** Unfinished stalls found, a previous run's included: no duration is known. */
  interrupted: number;
  /** The longest completed stall, or the newest unfinished one when none completed. */
  example: FreezeIncident;
};

/** The facts a summary carries beside its example stall. */
export type StallRate = Omit<StallTally, "example">;

/** Counts the stalls a recorder hands over; `read` answers undefined until there is one. */
export class StallCounter {
  private stalls = 0;
  private stallMs = 0;
  private interrupted = 0;
  private longest: FreezeLine | undefined;
  private unfinished: FreezeIncident | undefined;

  constructor(private readonly since: string) {}

  add(line: FreezeIncident): void {
    if ("wallMs" in line) {
      this.stalls += 1;
      this.stallMs += line.wallMs;
      if (!this.longest || line.wallMs > this.longest.wallMs) this.longest = line;
    } else if (line.status === "interrupted") {
      this.interrupted += 1;
      this.unfinished = line;
    }
  }

  read(until: string): StallTally | undefined {
    const example = this.longest ?? this.unfinished;
    if (!example) return undefined;
    return {
      since: this.since,
      until,
      stalls: this.stalls,
      stallMs: this.stallMs,
      interrupted: this.interrupted,
      example,
    };
  }
}

/**
 * The alpha recorder's automatic summary, once per installed version through
 * the durable inbox, independent of call path, restart or dismissal
 * (INF-2205). With `rate`, it says how many stalls this run has had and
 * names `line` as their example (INF-2971).
 */
export function freezeWake(
  line: FreezeIncident,
  project: { id: string; name: string },
  version: string,
  rate?: StallRate,
): TypedWake {
  const complete = "wallMs" in line ? line : undefined;
  return {
    facts: {
      kind: "freeze-recorded",
      project: { id: project.id, name: project.name },
      at: line.at,
      ...(line.build ? { build: line.build } : {}),
      ...(line.incidentId ? { incidentId: line.incidentId } : {}),
      ...(line.status ? { status: line.status } : {}),
      ...(line.captureRequestedAt ? { captureRequestedAt: line.captureRequestedAt } : {}),
      ...(line.capturedAt ? { capturedAt: line.capturedAt } : {}),
      wallMs: complete?.wallMs ?? null,
      cpuMs: complete?.cpuMs ?? null,
      frames: complete?.frames ?? [],
      ...(complete?.uncertain ? { uncertain: complete.uncertain } : {}),
      ...(rate
        ? {
            sinceStart: {
              since: rate.since,
              until: rate.until,
              stalls: rate.stalls,
              stallMs: rate.stallMs,
              interrupted: rate.interrupted,
            },
          }
        : {}),
    },
    once: `freeze-recorded:version:${version}`,
  };
}

/**
 * The recorder's main-thread half: it takes the watchdog (`./watchdog.ts`),
 * which the app's entry armed before the app's code loaded, hands it the
 * record, beats every `HEARTBEAT_MS` with the main thread's own processor
 * time, and hands each recorded line to `onFreeze`. With `onSummary`, it
 * also hands over the stalls counted since it started at each memory
 * reading's interval (`MEMORY_READING_MS`) once there is one, so a summary
 * carries a rate over a stretch of use, not the first stall of a start
 * (INF-2971). A watchdog that fails
 * stops the recorder and never the app. With `memory`, it also keeps the
 * memory reading (`./memoryRecorder.ts`), which needs no watchdog.
 */
export class FreezeRecorder {
  private worker: Worker | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private summary: ReturnType<typeof setInterval> | undefined;
  private counter: StallCounter | undefined;
  private readonly memory: MemoryRecorder | undefined;

  constructor(
    private readonly options: {
      recordPath: string;
      build?: SourceIdentity;
      onFreeze: (line: FreezeIncident) => void;
      onSummary?: (tally: StallTally) => void;
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
    const worker = takeWatchdog();
    if (!worker) return;
    this.worker = worker;
    const counter = new StallCounter(new Date().toISOString());
    this.counter = counter;
    worker.on("message", (message: unknown) => {
      const line = freezeIncidentSchema.safeParse(message);
      if (!line.success) return;
      counter.add(line.data);
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
    const onSummary = this.options.onSummary;
    if (onSummary) {
      this.summary = setInterval(() => {
        const tally = counter.read(new Date().toISOString());
        if (tally) onSummary(tally);
      }, MEMORY_READING_MS);
      this.summary.unref();
    }
  }

  /** The stalls counted since this recorder started, or undefined before the first. */
  tally(): StallTally | undefined {
    return this.counter?.read(new Date().toISOString());
  }

  stop(): void {
    this.memory?.stop();
    if (this.beat) clearInterval(this.beat);
    this.beat = undefined;
    if (this.summary) clearInterval(this.summary);
    this.summary = undefined;
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }
}
