import { describe, expect, it } from "vitest";
import { STAGE_CLOCK, StageClock, stageRateTarget } from "./stageClock";

function run(clock: StageClock, from: number, ms: number): number {
  let real = from;
  for (const end = from + ms; real < end; ) {
    real = Math.min(end, real + 16);
    clock.advance(real);
  }
  return real;
}

describe("the stage clock", () => {
  it("is the raw frame time, bit for bit, while nothing has slowed it", () => {
    const clock = new StageClock();
    for (const real of [1234.5678, 1251.2345, 1267.9012, 98765.4321]) {
      expect(clock.advance(real)).toBe(real);
      expect(clock.read(real + 3.21)).toBe(real + 3.21);
    }
    expect(clock.rate).toBe(1);
  });

  it("answers the same stage time to two loops asking for one frame", () => {
    const clock = new StageClock();
    clock.advance(1000);
    clock.target = STAGE_CLOCK.slow;
    const first = clock.advance(1016);
    const rate = clock.rate;
    expect(clock.advance(1016)).toBe(first);
    expect(clock.rate).toBe(rate);
    // A frame time behind the clock never runs it backward.
    expect(clock.advance(1010)).toBe(first);
  });

  it("eases down with the short constant and settles on the slow rate", () => {
    const clock = new StageClock();
    clock.advance(0);
    clock.target = STAGE_CLOCK.slow;
    clock.advance(STAGE_CLOCK.dropSeconds * 1000);
    // One time constant in, the gap has closed to 1/e.
    expect(clock.rate).toBeCloseTo(0.1 + 0.9 / Math.E, 6);
    const at = run(clock, STAGE_CLOCK.dropSeconds * 1000, 1000);
    expect(clock.rate).toBe(STAGE_CLOCK.slow);
    // Settled: stage time now advances at exactly a tenth of real time.
    const before = clock.advance(at);
    expect(clock.advance(at + 1000) - before).toBeCloseTo(100, 6);
  });

  it("eases back up with the longer constant, never a cut", () => {
    const clock = new StageClock();
    clock.advance(0);
    clock.target = 0;
    const at = run(clock, 0, 1000);
    expect(clock.rate).toBe(0);
    clock.target = 1;
    clock.advance(at + 16);
    expect(clock.rate).toBeGreaterThan(0);
    expect(clock.rate).toBeLessThan(0.1);
    clock.advance(at + STAGE_CLOCK.riseSeconds * 1000);
    expect(clock.rate).toBeCloseTo(1 - 1 / Math.E, 2);
    run(clock, at + STAGE_CLOCK.riseSeconds * 1000, 1500);
    expect(clock.rate).toBe(1);
  });

  it("holds stage time exactly still at rate 0, and stamps read that same time", () => {
    const clock = new StageClock();
    clock.advance(0);
    clock.target = 0;
    let at = run(clock, 0, 1000);
    const held = clock.advance(at);
    for (let i = 0; i < 200; i++) {
      at += 16.7;
      expect(clock.advance(at)).toBe(held);
    }
    expect(clock.read(at + 5)).toBe(held);
  });

  it("integrates the eased rate exactly, however the frames fall", () => {
    const coarse = new StageClock();
    const fine = new StageClock();
    for (const clock of [coarse, fine]) {
      clock.advance(0);
      clock.target = STAGE_CLOCK.slow;
    }
    coarse.advance(90);
    for (let real = 1; real <= 90; real++) fine.advance(real);
    expect(coarse.advance(90)).toBeCloseTo(fine.advance(90), 9);
    expect(coarse.rate).toBeCloseTo(fine.rate, 9);
    // 90 ms of real time at an eased rate between 1 and 0.1.
    expect(coarse.advance(90)).toBeGreaterThan(9);
    expect(coarse.advance(90)).toBeLessThan(90);
  });

  it("keeps running from where it paused once it is back at full speed", () => {
    const clock = new StageClock();
    clock.advance(0);
    clock.target = 0;
    let at = run(clock, 0, 2000);
    const held = clock.advance(at);
    clock.target = 1;
    at = run(clock, at, 2000);
    expect(clock.rate).toBe(1);
    const resumed = clock.advance(at);
    expect(resumed).toBeGreaterThan(held);
    expect(clock.advance(at + 1000) - resumed).toBeCloseTo(1000, 6);
    // An event stamped between frames lands between them on the stage too.
    expect(clock.read(at + 1008) - clock.advance(at + 1000)).toBeCloseTo(8, 6);
  });

  it("settles to full speed at once, from where it stands, for a reduced-motion still", () => {
    const clock = new StageClock();
    clock.advance(0);
    clock.target = 0;
    const at = run(clock, 0, 60);
    const before = clock.advance(at);
    expect(clock.rate).toBeGreaterThan(0);
    expect(clock.rate).toBeLessThan(1);
    clock.settle();
    expect(clock.rate).toBe(1);
    expect(clock.target).toBe(1);
    expect(clock.advance(at)).toBe(before);
    expect(clock.advance(at + 500) - before).toBeCloseTo(500, 6);
  });

  it("stamps an event between slowed frames at the slowed time", () => {
    const clock = new StageClock();
    clock.advance(0);
    clock.target = STAGE_CLOCK.slow;
    const at = run(clock, 0, 1000);
    expect(clock.read(at + 10) - clock.advance(at)).toBeCloseTo(1, 6);
  });
});

describe("what the stage eases toward", () => {
  const inside = { crew: true, inZone: true, onCrewmate: false, restedMs: 0 };
  it("runs at full speed with the pointer away, absent, or nobody out", () => {
    expect(stageRateTarget(null)).toBe(1);
    expect(stageRateTarget({ ...inside, inZone: false })).toBe(1);
    expect(stageRateTarget({ ...inside, crew: false })).toBe(1);
    expect(stageRateTarget({ ...inside, crew: false, onCrewmate: true })).toBe(1);
  });
  it("slows to a tenth inside the formation and pauses on a crewmate", () => {
    expect(stageRateTarget(inside)).toBe(0.1);
    expect(stageRateTarget({ ...inside, onCrewmate: true })).toBe(0);
    // A crewmate read from the keyboard pauses it with no pointer in the zone.
    expect(stageRateTarget({ ...inside, inZone: false, onCrewmate: true })).toBe(0);
  });
  it("lets go of a pointer resting inside the zone, but never one on a crewmate", () => {
    expect(stageRateTarget({ ...inside, restedMs: STAGE_CLOCK.restMs - 1 })).toBe(0.1);
    expect(stageRateTarget({ ...inside, restedMs: STAGE_CLOCK.restMs })).toBe(1);
    expect(stageRateTarget({ ...inside, onCrewmate: true, restedMs: 600_000 })).toBe(0);
  });
});
