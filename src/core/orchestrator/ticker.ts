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
 * it registered, synchronously; a registration that starts async work
 * returns without awaiting it, exactly as its own interval did. A throw in
 * one registration does not skip the rest - the passes were separate
 * intervals before they shared this one - and once the tick has run them
 * all every throw is raised again: a lone one as itself, several as one
 * `AggregateError` naming each pass, so none is lost to the first.
 */

/** Reads the current time in epoch milliseconds. */
export type Clock = () => number;

/** The timer the ticker's one interval runs on (injected in tests). */
export type TickerTimers = {
  repeat(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

/** The ticker's period: every cadence is a whole number of these. */
export const TICK_PERIOD_MS = 60_000;

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
  periodMs?: number;
  timers?: TickerTimers;
};

export class Ticker {
  /** The one clock; hand it to anything whose arithmetic the passes compare against. */
  readonly now: Clock;
  private readonly periodMs: number;
  private readonly timers: TickerTimers;
  private readonly registrations: Registration[] = [];
  private handle: unknown;

  constructor(options: TickerOptions = {}) {
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
   * positive whole number of periods. Returns the unregistration.
   */
  register(name: string, cadenceMs: number, run: (now: number) => void): () => void {
    if (this.registrations.some((entry) => entry.name === name)) {
      throw new Error(`The ticker already runs "${name}".`);
    }
    const every = cadenceMs / this.periodMs;
    if (!Number.isInteger(every) || every < 1) {
      throw new Error(
        `"${name}" needs a cadence that is a whole number of ${this.periodMs} ms periods; got ${cadenceMs}.`,
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
    this.handle = this.timers.repeat(() => this.tick(), this.periodMs);
  }

  /** Stop the one interval; the registrations stay for a later start. */
  stop(): void {
    if (this.handle === undefined) return;
    this.timers.cancel(this.handle);
    this.handle = undefined;
  }

  /** One tick: read the clock once, run every due registration in order. */
  tick(): void {
    const now = this.now();
    const failures: { name: string; error: unknown }[] = [];
    for (const entry of [...this.registrations]) {
      entry.due -= 1;
      if (entry.due > 0) continue;
      entry.due = entry.every;
      try {
        entry.run(now);
      } catch (error) {
        failures.push({ name: entry.name, error });
      }
    }
    const [only] = failures;
    if (failures.length === 1 && only) throw only.error;
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `${failures.length} ticker passes failed: ${failures.map((failure) => failure.name).join(", ")}`,
      );
    }
  }
}
