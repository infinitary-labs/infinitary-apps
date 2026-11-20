import { describe, expect, it } from "vitest";
import {
  FLICKER_TUNING,
  flickerEnvelope,
  flickerMerge,
  requestFirstmateFlicker,
  takeFirstmateFlicker,
  tokenIntensity,
  usageTotal,
} from "./flicker";

const DURATION = FLICKER_TUNING.durationMs;

function drain(): number[] {
  const out: number[] = [];
  for (let s = takeFirstmateFlicker(); s !== undefined; s = takeFirstmateFlicker()) out.push(s);
  return out;
}

describe("usageTotal", () => {
  it("counts every token the request spent, and never the cost", () => {
    expect(
      usageTotal({ input: 1200, output: 300, cacheRead: 40_000, cacheWrite: 500, cost: 9 }),
    ).toBe(42_000);
    expect(usageTotal({ output: 17 })).toBe(17);
    expect(usageTotal({ cost: 0.4 })).toBe(0);
  });
});

describe("tokenIntensity at the shipped tuning", () => {
  it("runs from 0.10 at 100 tokens to 1.40 at 500k, clamped at both ends", () => {
    expect(tokenIntensity(100)).toBeCloseTo(0.1, 10);
    expect(tokenIntensity(500_000)).toBeCloseTo(1.4, 10);
    expect(tokenIntensity(1)).toBeCloseTo(0.1, 10);
    expect(tokenIntensity(0)).toBeCloseTo(0.1, 10);
    expect(tokenIntensity(5_000_000)).toBeCloseTo(1.4, 10);
  });

  it("is logarithmic: equal ratios are equal steps", () => {
    // The geometric midpoint of 100..500k sits at the middle of the range.
    expect(tokenIntensity(Math.sqrt(100 * 500_000))).toBeCloseTo(0.75, 10);
    const step = (a: number) => tokenIntensity(a * 10) - tokenIntensity(a);
    expect(step(200)).toBeCloseTo(step(2_000), 10);
    expect(step(2_000)).toBeCloseTo(step(20_000), 10);
  });

  it("gets brighter with every larger request", () => {
    let prev = tokenIntensity(100);
    for (const total of [400, 1_500, 8_000, 40_000, 180_000, 499_000]) {
      const next = tokenIntensity(total);
      expect(next).toBeGreaterThan(prev);
      prev = next;
    }
  });
});

describe("flickerEnvelope at the shipped tuning", () => {
  const sample = (from: number, to: number, step = 1) => {
    const out: number[] = [];
    for (let t = from; t < to; t += step) out.push(flickerEnvelope(t));
    return out;
  };

  it("is nothing before it starts and nothing once its 2s are up", () => {
    expect(flickerEnvelope(-1)).toBe(0);
    expect(flickerEnvelope(0)).toBe(0);
    expect(flickerEnvelope(DURATION)).toBe(0);
    expect(flickerEnvelope(DURATION + 500)).toBe(0);
    expect(flickerEnvelope(Number.POSITIVE_INFINITY)).toBe(0);
    expect(flickerEnvelope(Number.NaN)).toBe(0);
  });

  it("wavers in four pulses whose dips go most of the way dark (depth 1)", () => {
    const all = sample(0, DURATION);
    let peaks = 0;
    for (let i = 1; i < all.length - 1; i++) {
      const v = all[i] as number;
      if (v > (all[i - 1] as number) && v >= (all[i + 1] as number) && v > 0.02) peaks += 1;
    }
    expect(peaks).toBe(FLICKER_TUNING.pulses);
    // The first dip, a quarter-period past the first pulse, nearly blacks out.
    const firstPeak = Math.max(...sample(0, DURATION / 8));
    const firstDip = Math.min(...sample(DURATION / 8, DURATION / 4));
    expect(firstDip).toBeLessThan(firstPeak * 0.25);
  });
});

describe("flickerMerge", () => {
  it("never lets a small request dim a big one still playing", () => {
    const big = tokenIntensity(400_000);
    const small = tokenIntensity(300);
    const at = 1000;
    const now = at + 100;
    const merged = flickerMerge(at, big, small, now);
    expect(merged).toBeGreaterThan(small);
    expect(merged).toBeCloseTo(flickerEnvelope(100) * big, 10);
  });

  it("starts fresh from the new request once the old flicker is over", () => {
    expect(flickerMerge(0, 1.4, 0.3, DURATION + 1)).toBe(0.3);
    expect(flickerMerge(Number.NEGATIVE_INFINITY, 0, 0.3, 50)).toBe(0.3);
  });
});

describe("the Firstmate's flicker channel", () => {
  it("keeps only the newest handful when requests pile up between frames", () => {
    drain();
    for (let i = 1; i <= 10; i++) requestFirstmateFlicker(i / 10);
    expect(drain()).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });
});
