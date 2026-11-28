/**
 * The minute pass's steps, timed for the freeze recorder
 * (docs/freeze-recorder.md, "The minute pass's steps"; INF-4076 found most
 * recorded stalls begin right after the once-a-minute pass and could not tell
 * which step crossed the line).
 *
 * The ticker runs each pass through `run`, and so do the work the passes set
 * off that runs in its own turn: the sweep's release, the board's push and
 * the presentation refresh. A task's close runs its parts through it too
 * (docs/freeze-recorder.md, "A task's close"). With a listener attached, which the recorder does
 * in an alpha build, `run` tells the watchdog which step is running and which
 * steps' promised work has not settled yet, so a stall is tagged with them,
 * and keeps each run's timing: when it started after the pass began, its
 * synchronous time, the main thread's own processor time in it and, for a
 * step that returned a promise, when that promise settled. Every run between
 * one pass's start and the next is handed over as one pass at the next
 * start. With no listener `run` only calls the step, so a build without the
 * recorder times nothing.
 *
 * Work outside the pass runs through it too, so a stall in it is named
 * (docs/freeze-recorder.md, "Work outside the pass"; INF-7202 found two
 * thirds of the stall time outside every step). Work that runs many times a
 * minute, such as a timer or a message on a connection, is `tally`: its runs
 * are added up per name in the pass instead of listed one by one. Each run
 * that ends also tells the listener its own time, less the time of the steps
 * run inside it, so the watchdog can say which steps filled a stall without
 * counting a nested step twice.
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

/** A tallied step's runs within a pass, added up, in milliseconds. */
export type TalliedTiming = {
  name: string;
  runs: number;
  syncMs: number;
  cpuMs: number;
  /** The longest single run's synchronous time. */
  maxSyncMs: number;
};

/** Every step run from one pass's start to the next; `tallied` is absent when no tallied step ran. */
export type PassTiming = { at: string; steps: StepTiming[]; tallied?: TalliedTiming[] };

/**
 * One run that just ended, for the watchdog's account of a stall: its own
 * synchronous time and processor time, less those of the steps run inside it.
 */
export type RunEnded = { name: string; selfMs: number; cpuSelfMs: number };

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
  // Optional for old records and passes in which no tallied step ran.
  tallied: z
    .array(
      z.object({
        name: z.string(),
        runs: z.number().int().positive(),
        syncMs: z.number(),
        cpuMs: z.number(),
        maxSyncMs: z.number(),
      }),
    )
    .optional(),
});
export type PassLine = z.infer<typeof passLineSchema>;

/** `PassSteps.run` as the core hands it to the work it times. */
export type StepRunner = <T>(name: string, run: () => T, options?: { tally?: boolean }) => T;

/** The runner where no steps are timed: it only runs the work. */
export const unstepped: StepRunner = (_name, run) => run();

export type StepListener = {
  mark(mark: StepMark): void;
  pass(pass: PassTiming): void;
  ran?(run: RunEnded): void;
};

type OpenPass = {
  at: string;
  startedAt: number;
  steps: StepTiming[];
  tallied: Map<string, TalliedTiming>;
};

/** A run in progress, with the time of the steps run inside it so far. */
type Open = { name: string; childMs: number; childCpuMs: number };

/** Thousandths of a millisecond are noise beside a 50 ms stall; one decimal is kept. */
const tenths = (ms: number) => Math.round(ms * 10) / 10;

export class PassSteps {
  private listener: StepListener | undefined;
  private readonly running: Open[] = [];
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

  passStarted(): void {
    const listener = this.listener;
    if (!listener) return;
    const done = this.pass;
    this.pass = {
      at: new Date(this.clock.wall()).toISOString(),
      startedAt: this.clock.now(),
      steps: [],
      tallied: new Map(),
    };
    if (!done) return;
    const pass: PassTiming = { at: done.at, steps: done.steps.map((timing) => ({ ...timing })) };
    if (done.tallied.size) pass.tallied = [...done.tallied.values()].map(talliedOut);
    listener.pass(pass);
  }

  /**
   * Runs one step. `tally` adds its runs up per name in the pass instead of
   * listing each, for work that runs many times a minute; a tallied step's
   * promise is not followed.
   */
  run<T>(name: string, step: () => T, options?: { tally?: boolean }): T {
    const listener = this.listener;
    if (!listener) return step();
    const pass = this.pass;
    const startedAt = this.clock.now();
    const cpuBefore = this.clock.cpuMicros();
    const open: Open = { name, childMs: 0, childCpuMs: 0 };
    this.running.push(open);
    this.marked();
    let result: T;
    try {
      result = step();
    } finally {
      const syncMs = this.clock.now() - startedAt;
      const cpuMs = (this.clock.cpuMicros() - cpuBefore) / 1000;
      if (options?.tally) {
        if (pass) tallyRun(pass.tallied, name, syncMs, cpuMs);
      } else {
        pass?.steps.push({
          name,
          startMs: pass ? tenths(startedAt - pass.startedAt) : 0,
          syncMs: tenths(syncMs),
          cpuMs: tenths(cpuMs),
        });
      }
      this.running.pop();
      const parent = this.running.at(-1);
      if (parent) {
        parent.childMs += syncMs;
        parent.childCpuMs += cpuMs;
      }
      listener.ran?.({
        name,
        selfMs: tenths(Math.max(0, syncMs - open.childMs)),
        cpuSelfMs: tenths(Math.max(0, cpuMs - open.childCpuMs)),
      });
      this.marked();
    }
    if (!options?.tally && isThenable(result)) this.follow(name, result, startedAt, pass);
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
      running: this.running.at(-1)?.name ?? null,
      unsettled: [...this.unsettled.keys()],
    });
  }
}

function tallyRun(
  tallied: Map<string, TalliedTiming>,
  name: string,
  syncMs: number,
  cpuMs: number,
): void {
  const sum = tallied.get(name);
  if (!sum) {
    tallied.set(name, { name, runs: 1, syncMs, cpuMs, maxSyncMs: syncMs });
    return;
  }
  sum.runs += 1;
  sum.syncMs += syncMs;
  sum.cpuMs += cpuMs;
  sum.maxSyncMs = Math.max(sum.maxSyncMs, syncMs);
}

function talliedOut(sum: TalliedTiming): TalliedTiming {
  return {
    name: sum.name,
    runs: sum.runs,
    syncMs: tenths(sum.syncMs),
    cpuMs: tenths(sum.cpuMs),
    maxSyncMs: tenths(sum.maxSyncMs),
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
