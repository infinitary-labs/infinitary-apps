import type { Worker } from "node:worker_threads";
import { forgeOf } from "@shared/forge";
import { z } from "zod";
import type { TypedWake } from "../orchestrator/wakes";
import { takeWatchdog } from "./watchdog";

/**
 * The freeze recorder (docs/freeze-recorder.md; INF-2061's plan, built as
 * INF-2066). A watchdog thread beside the app's main thread notices when the
 * main thread misses its heartbeat, asks V8 once for the JavaScript call path
 * the main thread is running, and writes one line per stall to a bounded
 * local record: when, how long between heartbeats, how much of that the main
 * thread's own processor time was, and the function names. It records no
 * arguments, values or text.
 */

/** The main thread's heartbeat to the watchdog. */
export const HEARTBEAT_MS = 50;
/** A main thread silent this long is frozen: INF-2061's plan, under every freeze it found. */
export const FREEZE_THRESHOLD_MS = 100;
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
  at: z.string(),
  wallMs: z.number().int().nonnegative(),
  cpuMs: z.number().int().nonnegative(),
  frames: z.array(frameSchema),
  uncertain: z.enum(["waited", "late"]).optional(),
});
export type FreezeLine = z.infer<typeof freezeLineSchema>;

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
 * The first mate's wake about one recorded freeze, once per call path: the
 * same freeze recurring is not new information.
 */
export function freezeWake(line: FreezeLine, project: { id: string; name: string }): TypedWake {
  const path = line.frames
    .slice(0, 3)
    .map((frame) => `${frame.name}@${frame.file}:${frame.line}`)
    .join("<");
  return {
    facts: {
      kind: "freeze-recorded",
      project: { id: project.id, name: project.name },
      at: line.at,
      wallMs: line.wallMs,
      cpuMs: line.cpuMs,
      frames: line.frames,
      ...(line.uncertain ? { uncertain: line.uncertain } : {}),
    },
    once: `freeze-recorded:${path || "unnamed"}`,
  };
}

/**
 * The recorder's main-thread half: it takes the watchdog (`./watchdog.ts`),
 * which the app's entry armed before the app's code loaded, hands it the
 * record, beats every `HEARTBEAT_MS` with the main thread's own processor
 * time, and hands each recorded line to `onFreeze`. A watchdog that fails
 * stops the recorder and never the app.
 */
export class FreezeRecorder {
  private worker: Worker | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: {
      recordPath: string;
      onFreeze: (line: FreezeLine) => void;
      thresholdMs?: number;
    },
  ) {}

  start(): void {
    if (this.worker) return;
    const worker = takeWatchdog();
    if (!worker) return;
    this.worker = worker;
    worker.on("message", (message: unknown) => {
      const line = freezeLineSchema.safeParse(message);
      if (line.success) this.options.onFreeze(line.data);
    });
    worker.on("error", () => this.stop());
    worker.postMessage({
      record: {
        path: this.options.recordPath,
        thresholdMs: this.options.thresholdMs ?? FREEZE_THRESHOLD_MS,
        maxLines: RECORD_MAX_LINES,
      },
    });
    const beat = () => worker.postMessage({ cpu: process.threadCpuUsage() });
    beat();
    this.beat = setInterval(beat, HEARTBEAT_MS);
    this.beat.unref();
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = undefined;
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }
}
