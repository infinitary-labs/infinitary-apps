/**
 * The minute pass's steps, timed for the freeze recorder
 * (docs/freeze-recorder.md, "The minute pass's steps"; INF-4076 found most
 * recorded stalls begin right after the once-a-minute pass and could not tell
 * which step crossed the line).
 *
 * The ticker runs each pass through `run`, and so do the work the passes set
 * off that runs in its own turn: the sweep's release, the board's push and
 * the presentation refresh. With a listener attached, which the recorder does
 * in an alpha build, `run` tells the watchdog which step is running and which
 * steps' promised work has not settled yet, so a stall is tagged with them,
 * and keeps each run's timing: when it started after the pass began, its
 * synchronous time, the main thread's own processor time in it and, for a
 * step that returned a promise, when that promise settled. Every run between
 * one pass's start and the next is handed over as one pass at the next
 * start. With no listener `run` only calls the step, so a build without the
 * recorder times nothing.
 *
 * It changes nothing a step does: the step's own result is returned, and a
 * promise that rejects still rejects unhandled exactly as before.
 */

import { sourceIdentitySchema } from "@shared/selfSource";
import { z } from "zod";

/** What the watchdog tags a stall with: the step running and the steps whose work is unsettled. */
export type StepMark = { running: string | null; unsettled: string[] };

/** One run of a step within a pass, in milliseconds. */
export type StepTiming = {
  name: string;
  /** When it started, after the pass started. */
  startMs: number;
  syncMs: number;
  /** The main thread's own processor time during its synchronous part. */
  cpuMs: number;
  /** When its promise settled, after it started; absent for a step that returned none. */
  workMs?: number;
  /** Its promise had not settled when the next pass started. */
  unsettled?: true;
};

/** Every step run from one pass's start to the next. */
export type PassTiming = { at: string; steps: StepTiming[] };

/** One line of the pass record (`AppPaths.passRecordPath`), as the watchdog writes it. */
export const passLineSchema = z.object({
  at: z.string(),
  build: sourceIdentitySchema.optional(),
  steps: z.array(
    z.object({
      name: z.string(),
      startMs: z.number(),
      syncMs: z.number(),
      cpuMs: z.number(),
      workMs: z.number().optional(),
      unsettled: z.literal(true).optional(),
    }),
  ),
});
export type PassLine = z.infer<typeof passLineSchema>;

export type StepListener = {
  mark(mark: StepMark): void;
  pass(pass: PassTiming): void;
};

type OpenPass = { at: string; startedAt: number; steps: StepTiming[] };

/** Thousandths of a millisecond are noise beside a 50 ms stall; one decimal is kept. */
const tenths = (ms: number) => Math.round(ms * 10) / 10;

export class PassSteps {
  private listener: StepListener | undefined;
  private readonly running: string[] = [];
  private readonly unsettled = new Map<string, number>();
  private pass: OpenPass | undefined;

  constructor(
    private readonly clock: {
      now: () => number;
      wall: () => number;
      cpuMicros: () => number;
    } = {
      now: () => performance.now(),
      wall: () => Date.now(),
      cpuMicros: () => {
        const usage = process.threadCpuUsage();
        return usage.user + usage.system;
      },
    },
  ) {}

  /** Attach the recorder; returns the detach. */
  listen(listener: StepListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener !== listener) return;
      this.listener = undefined;
      this.running.length = 0;
      this.unsettled.clear();
      this.pass = undefined;
    };
  }

  /** A pass begins: hand over the previous one and start collecting this one. */
  passStarted(): void {
    const listener = this.listener;
    if (!listener) return;
    const done = this.pass;
    this.pass = {
      at: new Date(this.clock.wall()).toISOString(),
      startedAt: this.clock.now(),
      steps: [],
    };
    if (done) listener.pass({ at: done.at, steps: done.steps.map((timing) => ({ ...timing })) });
  }

  /** Run one step, marked and timed while a listener is attached. */
  run<T>(name: string, step: () => T): T {
    const listener = this.listener;
    if (!listener) return step();
    const pass = this.pass;
    const startedAt = this.clock.now();
    const cpuBefore = this.clock.cpuMicros();
    this.running.push(name);
    this.marked();
    let result: T;
    try {
      result = step();
    } finally {
      const endedAt = this.clock.now();
      const timing: StepTiming = {
        name,
        startMs: pass ? tenths(startedAt - pass.startedAt) : 0,
        syncMs: tenths(endedAt - startedAt),
        cpuMs: tenths((this.clock.cpuMicros() - cpuBefore) / 1000),
      };
      pass?.steps.push(timing);
      this.running.pop();
      this.marked();
    }
    if (isThenable(result)) this.follow(name, result, startedAt, pass);
    return result;
  }

  private follow(
    name: string,
    work: PromiseLike<unknown>,
    startedAt: number,
    pass: OpenPass | undefined,
  ): void {
    const timing = pass?.steps.at(-1);
    if (timing) timing.unsettled = true;
    this.unsettled.set(name, (this.unsettled.get(name) ?? 0) + 1);
    this.marked();
    const listener = this.listener;
    const settled = () => {
      if (this.listener !== listener) return;
      const left = (this.unsettled.get(name) ?? 1) - 1;
      if (left > 0) this.unsettled.set(name, left);
      else this.unsettled.delete(name);
      if (timing) {
        timing.workMs = tenths(this.clock.now() - startedAt);
        delete timing.unsettled;
      }
      this.marked();
    };
    // The rejection goes on, unhandled, as it did before the step was timed.
    void Promise.resolve(work).then(settled, (error: unknown) => {
      settled();
      throw error;
    });
  }

  private marked(): void {
    this.listener?.mark({
      running: this.running.at(-1) ?? null,
      unsettled: [...this.unsettled.keys()],
    });
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
