import { afterEach, expect, it, vi } from "vitest";
import {
  LOAD_CLOCK_TICK_MS,
  linuxDiskWaits,
  requestDeadlinesOnLoadClock,
  startLoadClock,
  waitCap,
} from "./budgets";
import { tickedLoadClock } from "./loadClock";

// A branch check's runner stalled every vitest worker for 32.9 s while a
// forge request's 30 s deadline ran; the request ended, though the test's own
// limit, on the load clock, held.
const STALL_MS = 32_900;
const DEADLINE_MS = 30_000;

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  vi.useRealTimers();
});

it("keeps a request through a stall past its deadline, and ends it once the worker has run that long", () => {
  // The clock captures the timers it schedules on as it starts, so fake them first.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let wall = 0;
  // A quiet computer: every processor free, so load time is the time the worker runs.
  const clock = tickedLoadClock(
    () => wall,
    () => 1,
  );
  const native = AbortSignal.timeout;
  restores.push(requestDeadlinesOnLoadClock(clock));
  const signal = AbortSignal.timeout(DEADLINE_MS);

  // Stalled: the wall clock passes the deadline and its timer comes due, with no tick.
  wall += STALL_MS;
  vi.advanceTimersByTime(STALL_MS);
  expect(signal.aborted).toBe(false);

  // Running again: a tick each LOAD_CLOCK_TICK_MS, until the load time reaches the deadline.
  const run = () => {
    wall += LOAD_CLOCK_TICK_MS;
    clock.tick();
    vi.advanceTimersByTime(LOAD_CLOCK_TICK_MS);
  };
  while (clock.now() < DEADLINE_MS) {
    expect(signal.aborted).toBe(false);
    run();
  }
  run();
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toMatchObject({
    name: "TimeoutError",
    message: "The operation was aborted due to timeout",
  });

  restores.splice(0)[0]?.();
  expect(AbortSignal.timeout).toBe(native);
});

it("leaves the native deadline where the worker keeps no load clock, as on a graded run", () => {
  const native = AbortSignal.timeout;
  restores.push(requestDeadlinesOnLoadClock(undefined));
  expect(AbortSignal.timeout).toBe(native);
});

// Linux's I/O pressure counter as a two-processor Fedora 42 VM read it
// (/proc/pressure/io): `total` is microseconds some task waited on its disk.
const pressure = (some: number) =>
  `some avg10=2.64 avg60=1.10 avg300=0.26 total=${some}\nfull avg10=2.10 avg60=0.86 avg300=0.20 total=683115\n`;
const READ_TOTAL = 858_562;

// A merge batch's Linux job VM shared its disk with other work: brokered
// delivery's tests, which sync every file they save, took 41.2 s where they
// take 1 to 2.4 s, while the one-minute load stayed low and the worker's
// timer kept its beat, so each test ran out its 5 s limit.
const DISK_STALL_MS = 41_200;
const LIMIT_MS = 5_000;

it("reads how long the computer's work waited on its disk, and nothing where the kernel keeps no counter", () => {
  expect(linuxDiskWaits(() => pressure(READ_TOTAL))?.()).toBe(READ_TOTAL);
  const missing = () => {
    throw Object.assign(new Error("ENOENT: no such file or directory, open '/proc/pressure/io'"), {
      code: "ENOENT",
    });
  };
  expect(linuxDiskWaits(missing)).toBeUndefined();
});

/**
 * A quiet two-processor computer's clock, run by the test one tick at a time,
 * with or without its work waiting on the disk, up to a wall time the test
 * names, so a limit that never fires fails its test rather than holding it.
 */
function diskClock(counter: boolean) {
  // The clock captures the timers it ticks and schedules on as it starts, so fake them first.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let wall = 0;
  let waited = READ_TOTAL;
  let readable = true;
  const read = () => {
    // A read that fails answers as it does on a kernel started without the counter.
    if (!readable)
      throw Object.assign(new Error("EOPNOTSUPP: operation not supported on socket, read"), {
        code: "EOPNOTSUPP",
      });
    return pressure(waited);
  };
  const clock = startLoadClock(
    () => wall,
    () => 0,
    2,
    counter ? linuxDiskWaits(read) : undefined,
  );
  restores.push(clock.stop);
  let fired: number | undefined;
  clock.timer(() => {
    fired = wall;
  }, clock.now() + LIMIT_MS);
  const runTo = (until: number, onDisk: boolean) => {
    while (wall < until) {
      wall += LOAD_CLOCK_TICK_MS;
      if (onDisk) waited += LOAD_CLOCK_TICK_MS * 1000;
      vi.advanceTimersByTime(LOAD_CLOCK_TICK_MS);
    }
  };
  const unreadable = () => {
    readable = false;
  };
  return { clock, runTo, unreadable, fired: () => fired };
}

/** The limit fired once the clock had counted what was left of it after `from`, to the tick. */
function expectFiredAfter(fired: number | undefined, from: number, left: number) {
  expect(fired).toBeGreaterThan(from + left - LOAD_CLOCK_TICK_MS);
  expect(fired).toBeLessThanOrEqual(from + left + LOAD_CLOCK_TICK_MS);
}

it("holds a limit while the computer's work waits on its disk, and ends it once the work has run that long", () => {
  const run = diskClock(true);
  run.runTo(DISK_STALL_MS, true);
  expect(run.fired()).toBeUndefined();
  const held = run.clock.now();
  expect(held).toBeLessThan(LIMIT_MS);

  // The disk frees: the clock counts again until the limit's whole load time has passed.
  run.runTo(DISK_STALL_MS + LIMIT_MS + LOAD_CLOCK_TICK_MS, false);
  expectFiredAfter(run.fired(), DISK_STALL_MS, LIMIT_MS - held);
});

it("counts every tick once the disk counter cannot be read, not the share it last read", () => {
  const run = diskClock(true);
  run.runTo(DISK_STALL_MS, true);
  const held = run.clock.now();
  run.unreadable();
  run.runTo(DISK_STALL_MS + LIMIT_MS + LOAD_CLOCK_TICK_MS, true);
  expectFiredAfter(run.fired(), DISK_STALL_MS, LIMIT_MS - held);
});

it("still ends a limit by its wall cap when the disk never frees", () => {
  const run = diskClock(true);
  run.runTo(waitCap(LIMIT_MS) + LOAD_CLOCK_TICK_MS, true);
  expect(run.fired()).toBe(waitCap(LIMIT_MS));
});

it("counts every tick where the computer keeps no disk counter, as before", () => {
  const run = diskClock(false);
  run.runTo(LIMIT_MS + LOAD_CLOCK_TICK_MS, true);
  expect(run.fired()).toBe(LIMIT_MS);
});
