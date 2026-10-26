/**
 * The host's one clock (P5, `docs/architecture.md` §17): one interval and
 * one injectable `now`. Everything the orchestrator runs on a cadence - the
 * quiet-turn watchdog, the idle ladder (and the job bound it reads), the
 * gate and inbox sweeps, the schedules - registers here instead of owning
 * a timer, and the stores whose arithmetic those passes compare against
 * (the inbox's grace and backoff, the task record's idle clock) are handed
 * the same `now`, so a test moves one clock instead of faking `Date`.
 *
 * A tick reads the clock once and runs every due registration in the order
 * it registered. The application yields an event-loop turn between passes;
 * `tick()` is the synchronous driver for a test's manual clock. A registration that starts async work
 * returns without awaiting it, exactly as its own interval did. A throw in
 * one registration does not skip the rest - the passes were separate
 * intervals before they shared this one - and once the tick has run them
 * all every throw is raised again: a lone one as itself, several as one
 * `AggregateError` naming each pass, so none is lost to the first.
 *
 * Cadences count the design's one-minute period (`TICK_PERIOD_MS`). A
 * development or end-to-end run may make the interval's period shorter
 * (`tickPeriodFor`), and every pass then runs sooner in proportion, so a
 * journey waiting on one need not wait out the minute; a packaged build
 * always ticks once a minute.
 */

import { settingFrom } from "@shared/envSettings";

/** Reads the current time in epoch milliseconds. */
export type Clock = () => number;

/** The timer the ticker's one interval runs on (injected in tests). */
export type TickerTimers = {
  repeat(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

/** The design's period: every cadence is a whole number of these. */
export const TICK_PERIOD_MS = 60_000;

/**
 * The period a run of the app ticks at: `TICK_PERIOD_MS`, or a shorter one
 * a development or end-to-end run names in `INFINITARY_TICK_PERIOD_MS`. A
 * packaged build always ticks at the design's period, and a value that is
 * not a whole number of milliseconds from 1 to `TICK_PERIOD_MS` is ignored.
 */
export function tickPeriodFor(
  packaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): number {
  if (packaged) return TICK_PERIOD_MS;
  const named = Number(settingFrom(env, "TICK_PERIOD_MS")?.trim() || Number.NaN);
  return Number.isInteger(named) && named >= 1 && named <= TICK_PERIOD_MS ? named : TICK_PERIOD_MS;
}

type Registration = {
  name: string;
  /** Runs on every `every`-th tick after it registered. */
  every: number;
  /** Ticks until it next runs. */
  due: number;
  run: (now: number) => void;
};

export type TickerOptions = {
  now?: Clock;
  /**
   * How long one period lasts on the interval: `TICK_PERIOD_MS` unless a
   * test build shortens it (`tickPeriodFor`). Cadences still count the
   * design's periods, so a shorter one runs every pass sooner in proportion.
   */
  periodMs?: number;
  timers?: TickerTimers;
  /** Duration of each pass's synchronous work, including a pass that throws. */
  measured?: (name: string, durationMs: number) => void;
  /** Let the host service input and I/O before each due pass. */
  betweenPasses?: () => Promise<void>;
  /** Hold derived presentation across a sweep; release even on stop or failure. */
  sweep?: () => () => void;
};

export class Ticker {
  /** The one clock; hand it to anything whose arithmetic the passes compare against. */
  readonly now: Clock;
  private readonly periodMs: number;
  private readonly timers: TickerTimers;
  private readonly registrations: Registration[] = [];
  private readonly measured: TickerOptions["measured"];
  private readonly betweenPasses: TickerOptions["betweenPasses"];
  private readonly sweep: TickerOptions["sweep"];
  private running = false;
  private generation = 0;
  private handle: unknown;

  constructor(options: TickerOptions = {}) {
    this.measured = options.measured;
    this.betweenPasses = options.betweenPasses;
    this.sweep = options.sweep;
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
    this.periodMs = options.periodMs ?? TICK_PERIOD_MS;
    this.timers = options.timers ?? {
      repeat: (run, ms) => setInterval(run, ms),
      cancel: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
    };
  }

  /**
   * Run `run` every `cadenceMs`: first on the tick one cadence after it
   * registers, then once per cadence. Refuses a duplicate name and a cadence that is not a
   * positive whole number of the design's periods. Returns the unregistration.
   */
  register(name: string, cadenceMs: number, run: (now: number) => void): () => void {
    if (this.registrations.some((entry) => entry.name === name)) {
      throw new Error(`The ticker already runs "${name}".`);
    }
    const every = cadenceMs / TICK_PERIOD_MS;
    if (!Number.isInteger(every) || every < 1) {
      throw new Error(
        `"${name}" needs a cadence that is a whole number of ${TICK_PERIOD_MS} ms periods; got ${cadenceMs}.`,
      );
    }
    const entry: Registration = { name, every, due: every, run };
    this.registrations.push(entry);
    return () => {
      const index = this.registrations.indexOf(entry);
      if (index >= 0) this.registrations.splice(index, 1);
    };
  }

  /** Start the one interval; idempotent. */
  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.timers.repeat(() => {
      if (!this.betweenPasses) this.tick();
      else
        void this.tickInTurns().catch((error: unknown) => {
          queueMicrotask(() => {
            throw error;
          });
        });
    }, this.periodMs);
  }

  /** Stop the one interval; the registrations stay for a later start. */
  stop(): void {
    this.generation += 1;
    if (this.handle === undefined) return;
    this.timers.cancel(this.handle);
    this.handle = undefined;
  }

  /** One manual tick: same clock, cadence, timing and failure rules as the interval. */
  tick(): void {
    const now = this.now();
    const failures: PassFailure[] = [];
    for (const entry of this.due()) this.run(entry, now, failures);
    raiseFailures(failures);
  }

  /** The interval's pass: no overlapping sweep and no backlog of missed sweeps. */
  async tickInTurns(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    const now = this.now();
    const failures: PassFailure[] = [];
    let release: (() => void) | undefined;
    try {
      release = this.sweep?.();
      for (const entry of this.due()) {
        await this.betweenPasses?.();
        if (generation !== this.generation) break;
        // A pass removed while we yielded must not run after its owner stopped.
        if (this.registrations.includes(entry)) this.run(entry, now, failures);
      }
      raiseFailures(failures);
    } finally {
      try {
        release?.();
      } finally {
        this.running = false;
      }
    }
  }

  private due(): Registration[] {
    return this.registrations.filter((entry) => {
      entry.due -= 1;
      if (entry.due > 0) return false;
      entry.due = entry.every;
      return true;
    });
  }

  private run(entry: Registration, now: number, failures: PassFailure[]): void {
    const started = performance.now();
    try {
      entry.run(now);
    } catch (error) {
      failures.push({ name: entry.name, error });
    } finally {
      this.measured?.(entry.name, performance.now() - started);
    }
  }
}

type PassFailure = { name: string; error: unknown };

function raiseFailures(failures: PassFailure[]): void {
  const [only] = failures;
  if (failures.length === 1 && only) throw only.error;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `${failures.length} ticker passes failed: ${failures.map((failure) => failure.name).join(", ")}`,
    );
  }
}
