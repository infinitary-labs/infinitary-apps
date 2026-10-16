import { describe, expect, it } from "vitest";
import { FIDGET_DURATION_MS } from "../machine";
import { CREW_RUSH, CrewRush, streakArc } from "./rush";

const BH = FIDGET_DURATION_MS.blackhole;
/** The black hole's wind-up and unwind start, ms into it (bhEnvelope's schedule). */
const WIND = 0.05 * BH;
const UNWIND = 0.8 * BH;

/** Play a black hole that began at `start`, frame by frame, until `until`. */
function play(rush: CrewRush, start: number, until: number): void {
  for (let t = start; t <= until; t += 16) rush.playing(start, BH, t);
}

describe("the black hole's rush", () => {
  it("is still before any black hole", () => {
    const rush = new CrewRush();
    expect(rush.level(0)).toBe(0);
    rush.stopped(1000);
    expect(rush.level(5000)).toBe(0);
  });

  it("ramps from the wind-up, holds at the top, and settles from the unwind", () => {
    const rush = new CrewRush();
    play(rush, 1000, 1000 + BH);
    rush.stopped(1000 + BH);
    const at = (ms: number) => rush.level(1000 + ms);
    expect(at(0)).toBe(0);
    expect(at(WIND)).toBe(0);
    // Half way through the ramp, half way up; then the top until the unwind.
    expect(at(WIND + CREW_RUSH.rampMs / 2)).toBeCloseTo(0.5, 12);
    expect(at(WIND + CREW_RUSH.rampMs)).toBe(1);
    expect(at(UNWIND)).toBe(1);
    // Ending on its own changes nothing: the settle began with the unwind.
    expect(at(UNWIND + CREW_RUSH.settleMs / 2)).toBeCloseTo(0.5, 12);
    expect(at(UNWIND + CREW_RUSH.settleMs)).toBe(0);
    expect(at(UNWIND + CREW_RUSH.settleMs + 10_000)).toBe(0);
    // Never a jump: consecutive frames differ by a small step.
    for (let t = 0; t < UNWIND + CREW_RUSH.settleMs; t += 16) {
      expect(Math.abs(at(t + 16) - at(t))).toBeLessThan(0.02);
    }
  });

  it("starts settling the moment a black hole is cut short, from where it had reached", () => {
    const rush = new CrewRush();
    play(rush, 0, 1000);
    const reached = rush.level(1000);
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(1);
    rush.stopped(1000);
    expect(rush.level(1000)).toBeCloseTo(reached, 12);
    expect(rush.level(1000 + CREW_RUSH.settleMs / 2)).toBeCloseTo(reached / 2, 12);
    expect(rush.level(1000 + CREW_RUSH.settleMs)).toBe(0);

    const held = new CrewRush();
    play(held, 0, 3000);
    held.stopped(3000);
    expect(held.level(3000)).toBe(1);
    expect(held.level(3000 + CREW_RUSH.settleMs)).toBe(0);
  });

  it("follows a black hole whose clock is pinned", () => {
    const rush = new CrewRush();
    // A review page holds the emote at 3 s in while stage time runs on.
    for (let t = 10_000; t < 12_000; t += 16) rush.playing(t - 3000, BH, t);
    expect(rush.level(11_984)).toBe(1);
  });

  it("carries on from a rush still settling when the next black hole begins", () => {
    const rush = new CrewRush();
    play(rush, 0, BH);
    rush.stopped(BH);
    const t = UNWIND + CREW_RUSH.settleMs / 2;
    const settling = rush.level(t);
    rush.playing(t, BH, t);
    expect(rush.level(t)).toBeCloseTo(settling, 12);
    expect(rush.level(t + WIND + CREW_RUSH.rampMs)).toBe(1);
  });
});

describe("speed streaks", () => {
  const degrees = (d: number) => (d * Math.PI) / 180;
  it("are absent at the crew's normal pace and vanish as the rush fades", () => {
    for (const speed of [8, -20, -4]) {
      expect(streakArc(degrees(speed), 0)).toBe(0);
      // A hundredth of the way up, the arc is far too short to see.
      expect(streakArc(degrees(speed * (1 + (CREW_RUSH.peak - 1) * 0.01)), 0.01)).toBe(0);
    }
  });

  it("cover the arc swept in a moment at the top speed, scaled by the rush and capped", () => {
    const inner = degrees(8 * CREW_RUSH.peak);
    expect(streakArc(inner, 1)).toBeCloseTo(inner * CREW_RUSH.streakSeconds, 12);
    expect(streakArc(-inner, 1)).toBeCloseTo(inner * CREW_RUSH.streakSeconds, 12);
    expect(streakArc(inner, 0.5)).toBeCloseTo(inner * CREW_RUSH.streakSeconds * 0.5, 12);
    expect(streakArc(degrees(100_000), 1)).toBe(CREW_RUSH.streakMaxRad);
    expect(streakArc(inner, 0)).toBe(0);
  });
});
