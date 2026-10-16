import { describe, expect, it } from "vitest";
import { TICK_PERIOD_MS, Ticker, type TickerTimers } from "./ticker";

/** A stand-in for the one interval: records what was scheduled and fires it on demand. */
function manualTimers() {
  const scheduled: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const timers: TickerTimers = {
    repeat: (run, ms) => {
      const entry = { run, ms, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    cancel: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  };
  /** The interval elapsing once: every live schedule fires. */
  const elapse = () => {
    for (const entry of scheduled) if (!entry.cancelled) entry.run();
  };
  return { timers, scheduled, elapse };
}

function setup() {
  let clock = 1_000_000;
  const interval = manualTimers();
  const ticker = new Ticker({ now: () => clock, timers: interval.timers });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { ticker, interval, advance };
}

describe("Ticker (one clock, P5)", () => {
  it("runs every registration on one interval, in the order registered, with one reading of the clock", () => {
    const { ticker, interval, advance } = setup();
    const runs: [string, number][] = [];
    ticker.register("ladder", TICK_PERIOD_MS, (now) => runs.push(["ladder", now]));
    ticker.register("sweep", TICK_PERIOD_MS, (now) => {
      advance(5);
      runs.push(["sweep", now]);
    });
    ticker.register("schedules", TICK_PERIOD_MS, (now) => runs.push(["schedules", now]));
    ticker.start();

    expect(interval.scheduled).toHaveLength(1);
    expect(interval.scheduled[0]?.ms).toBe(TICK_PERIOD_MS);
    expect(runs).toEqual([]);

    advance(TICK_PERIOD_MS);
    interval.elapse();
    // A registration that moves time mid-tick does not move its neighbours' now.
    const at = 1_000_000 + TICK_PERIOD_MS;
    expect(runs).toEqual([
      ["ladder", at],
      ["sweep", at],
      ["schedules", at],
    ]);
  });

  it("runs a slower cadence once per whole number of periods, counted from its registration", () => {
    const { ticker, interval } = setup();
    const runs: string[] = [];
    ticker.register("each", TICK_PERIOD_MS, () => runs.push("each"));
    ticker.register("third", 3 * TICK_PERIOD_MS, () => runs.push("third"));
    ticker.start();
    for (let tick = 0; tick < 6; tick += 1) interval.elapse();
    expect(runs.filter((name) => name === "each")).toHaveLength(6);
    expect(runs.filter((name) => name === "third")).toHaveLength(2);
    expect(runs.indexOf("third")).toBe(3);

    // A late registration counts its own cadence, not the ticker's age.
    ticker.register("late", 2 * TICK_PERIOD_MS, () => runs.push("late"));
    interval.elapse();
    expect(runs).not.toContain("late");
    interval.elapse();
    expect(runs.filter((name) => name === "late")).toHaveLength(1);
  });

  it("refuses a duplicate name and a cadence that is not a whole number of periods", () => {
    const { ticker } = setup();
    ticker.register("sweep", TICK_PERIOD_MS, () => {});
    expect(() => ticker.register("sweep", TICK_PERIOD_MS, () => {})).toThrow(
      /already runs "sweep"/,
    );
    expect(() => ticker.register("half", TICK_PERIOD_MS / 2, () => {})).toThrow(/whole number/);
    expect(() => ticker.register("never", 0, () => {})).toThrow(/whole number/);
  });

  it("starts one interval however often it is started, and stops it cleanly", () => {
    const { ticker, interval } = setup();
    const runs: number[] = [];
    ticker.register("sweep", TICK_PERIOD_MS, (now) => runs.push(now));
    ticker.start();
    ticker.start();
    expect(interval.scheduled).toHaveLength(1);

    ticker.stop();
    expect(interval.scheduled[0]?.cancelled).toBe(true);
    interval.elapse();
    expect(runs).toEqual([]);
    // Stopping twice is a no-op; a restart is again one interval, same registrations.
    ticker.stop();
    ticker.start();
    expect(interval.scheduled.filter((entry) => !entry.cancelled)).toHaveLength(1);
    interval.elapse();
    expect(runs).toHaveLength(1);
  });

  it("drops an unregistered pass from the next tick", () => {
    const { ticker, interval } = setup();
    const runs: string[] = [];
    const unregister = ticker.register("schedules", TICK_PERIOD_MS, () => runs.push("schedules"));
    ticker.register("sweep", TICK_PERIOD_MS, () => runs.push("sweep"));
    ticker.start();
    interval.elapse();
    unregister();
    unregister();
    interval.elapse();
    expect(runs).toEqual(["schedules", "sweep", "sweep"]);
    // The name is free again.
    expect(() => ticker.register("schedules", TICK_PERIOD_MS, () => {})).not.toThrow();
  });

  it("runs the rest of a tick past a throwing pass, then raises that throw as itself", () => {
    const { ticker } = setup();
    const runs: string[] = [];
    const broke = new Error("quiet broke");
    ticker.register("quiet", TICK_PERIOD_MS, () => {
      throw broke;
    });
    ticker.register("schedules", TICK_PERIOD_MS, () => runs.push("schedules"));
    expect(() => ticker.tick()).toThrow(broke);
    expect(runs).toEqual(["schedules"]);
  });

  it("raises every throw of a tick, each named by its pass, never only the first", () => {
    const { ticker } = setup();
    const runs: string[] = [];
    const riders = new Error("riders broke");
    const schedules = new Error("schedules broke");
    ticker.register("watchdog-riders", TICK_PERIOD_MS, () => {
      throw riders;
    });
    ticker.register("inbox-sweep", TICK_PERIOD_MS, () => runs.push("inbox-sweep"));
    ticker.register("schedules", TICK_PERIOD_MS, () => {
      throw schedules;
    });
    let raised: unknown;
    try {
      ticker.tick();
    } catch (error) {
      raised = error;
    }
    expect(runs).toEqual(["inbox-sweep"]);
    expect(raised).toBeInstanceOf(AggregateError);
    expect((raised as AggregateError).errors).toEqual([riders, schedules]);
    expect((raised as AggregateError).message).toBe(
      "2 ticker passes failed: watchdog-riders, schedules",
    );
  });

  it("reads Date.now() when no clock is injected", () => {
    const ticker = new Ticker({ timers: manualTimers().timers });
    const before = Date.now();
    const now = ticker.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
