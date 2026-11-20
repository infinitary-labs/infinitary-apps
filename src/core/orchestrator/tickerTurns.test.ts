import { describe, expect, it, vi } from "vitest";
import { TICK_PERIOD_MS, Ticker } from "./ticker";

// INF-1348, accepted “All three”: housekeeping must give input/I/O a turn,
// without losing cadence, ordering, failures, or shutdown cancellation.
describe("housekeeping on separate turns", () => {
  it("services an I/O turn before each pass and measures even a failed pass", async () => {
    const order: string[] = [];
    const measured: string[] = [];
    const broke = new Error("failed sweep");
    const released = vi.fn();
    const ticker = new Ticker({
      sweep: () => released,
      now: () => 42,
      betweenPasses: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            order.push("input");
            resolve();
          }),
        ),
      measured: (name, ms) => {
        measured.push(name);
        expect(ms).toBeGreaterThanOrEqual(0);
      },
    });
    ticker.register("ladder", TICK_PERIOD_MS, (now) => {
      expect(now).toBe(42);
      order.push("ladder");
      throw broke;
    });
    ticker.register("gate", TICK_PERIOD_MS, () => order.push("gate"));
    await expect(ticker.tickInTurns()).rejects.toBe(broke);
    expect(order).toEqual(["input", "ladder", "input", "gate"]);
    expect(measured).toEqual(["ladder", "gate"]);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("does not overlap or queue a sweep and reads the clock only once", async () => {
    let release: (() => void) | undefined;
    const now = vi.fn(() => 100);
    const seen: number[] = [];
    const ticker = new Ticker({
      now,
      betweenPasses: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    ticker.register("ladder", TICK_PERIOD_MS, (at) => {
      seen.push(at);
    });
    const running = ticker.tickInTurns();
    await ticker.tickInTurns();
    expect(now).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    release?.();
    await running;
    expect(seen).toEqual([100]);
    // A skipped overlapping tick did not use the next cadence.
    const next = ticker.tickInTurns();
    release?.();
    await next;
    expect(seen).toEqual([100, 100]);
  });

  it("stops queued work and honours unregistration while yielding", async () => {
    const work = vi.fn();
    let release: (() => void) | undefined;
    const ticker = new Ticker({
      betweenPasses: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const remove = ticker.register("ladder", TICK_PERIOD_MS, work);
    const first = ticker.tickInTurns();
    remove();
    release?.();
    await first;
    expect(work).not.toHaveBeenCalled();
    ticker.register("gate", TICK_PERIOD_MS, work);
    const second = ticker.tickInTurns();
    ticker.stop();
    release?.();
    await second;
    expect(work).not.toHaveBeenCalled();
  });

  it("the production interval uses separate turns and preserves slower cadences", async () => {
    let fire: (() => void) | undefined;
    const measured: string[] = [];
    const ticker = new Ticker({
      timers: {
        repeat: (run) => {
          fire = run;
          return 1;
        },
        cancel: () => {},
      },
      betweenPasses: () => new Promise((resolve) => setImmediate(resolve)),
      measured: (name) => measured.push(name),
    });
    ticker.register("minute", TICK_PERIOD_MS, () => {});
    ticker.register("two-minutes", 2 * TICK_PERIOD_MS, () => {});
    ticker.start();
    fire?.();
    expect(measured).toEqual([]);
    await vi.waitFor(() => expect(measured).toEqual(["minute"]));
    fire?.();
    await vi.waitFor(() => expect(measured).toEqual(["minute", "minute", "two-minutes"]));
    ticker.stop();
  });
});
