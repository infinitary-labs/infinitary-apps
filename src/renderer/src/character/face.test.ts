import { describe, expect, it } from "vitest";
import { DEFAULT_POINTER_GAZE, Gaze, PointerGaze, Spring } from "./face";

const STEP = 1 / 120;

function run(p: PointerGaze, seconds: number) {
  let last = p.update(0);
  for (let t = 0; t < seconds; t += STEP) last = p.update(STEP);
  return last;
}

function settle(g: Gaze, seconds: number) {
  let last = g.update(0);
  for (let t = 0; t < seconds; t += STEP) last = g.update(STEP);
  return last;
}

describe("PointerGaze", () => {
  it("has no pull until the pointer moves", () => {
    const p = new PointerGaze();
    const pull = run(p, 1);
    expect(pull.weight).toBe(0);
    expect(pull.phase).toBe("absent");
  });

  it("captures the gaze toward the pointer's direction within the capture time", () => {
    const p = new PointerGaze();
    p.move(2, 0);
    const pull = run(p, DEFAULT_POINTER_GAZE.captureSeconds);
    expect(pull.phase).toBe("engaged");
    expect(pull.weight).toBeGreaterThan(0.9);
    expect(pull.x).toBeGreaterThan(0);
    expect(pull.y).toBe(0);
    p.move(-1, 1);
    const left = run(p, 0.1);
    expect(left.x).toBeLessThan(0);
    expect(left.y).toBeGreaterThan(0);
  });

  it("bounds the deflection to the gain however far the pointer goes", () => {
    const p = new PointerGaze({ gain: 1.2 });
    p.move(40, 30);
    const far = run(p, 0.5);
    expect(Math.hypot(far.x, far.y / DEFAULT_POINTER_GAZE.yScale)).toBeLessThanOrEqual(1.2 + 1e-9);
    expect(Math.hypot(far.x, far.y / DEFAULT_POINTER_GAZE.yScale)).toBeGreaterThan(1.19);
    p.move(0.1, 0);
    const near = run(p, 0.5);
    expect(near.x).toBeLessThan(0.2);
    expect(near.x).toBeGreaterThan(0);
  });

  it("looks straight ahead when the pointer sits on the character", () => {
    const p = new PointerGaze();
    p.move(0, 0);
    const pull = run(p, 0.5);
    expect(pull.x).toBe(0);
    expect(pull.y).toBe(0);
    expect(pull.weight).toBeGreaterThan(0.9);
  });

  it("loses interest in a resting pointer after the hold, on the release ease", () => {
    const p = new PointerGaze({ holdSeconds: 1, releaseSeconds: 0.5 });
    p.move(1, 0);
    const held = run(p, 0.9);
    expect(held.phase).toBe("engaged");
    expect(held.weight).toBeGreaterThan(0.95);
    const resting = run(p, 0.2);
    expect(resting.phase).toBe("resting");
    expect(resting.weight).toBeLessThan(held.weight);
    const gone = run(p, 0.6);
    expect(gone.weight).toBeLessThan(0.05);
    p.move(1, 0);
    expect(run(p, 0.3).weight).toBeGreaterThan(0.9);
  });

  it("lets go when the pointer leaves the window", () => {
    const p = new PointerGaze({ releaseSeconds: 0.5 });
    p.move(1, 0);
    run(p, 0.5);
    p.leave();
    const first = p.update(STEP);
    expect(first.phase).toBe("absent");
    const later = run(p, 0.6);
    expect(later.weight).toBeLessThan(0.05);
  });
});

describe("Gaze.attract", () => {
  it("draws a held look toward the pull by its weight and lets it go", () => {
    const g = new Gaze();
    g.look(0.8, 0.6);
    g.attract(-0.8, -0.6, 1);
    const pulled = settle(g, 2);
    expect(pulled.x).toBeCloseTo(-0.8, 2);
    expect(pulled.y).toBeCloseTo(-0.6, 2);
    g.attract(-0.8, -0.6, 0.5);
    const half = settle(g, 2);
    expect(half.x).toBeCloseTo(0, 2);
    expect(half.y).toBeCloseTo(0, 2);
    g.attract(0, 0, 0);
    const released = settle(g, 2);
    expect(released.x).toBeCloseTo(0.8, 2);
    expect(released.y).toBeCloseTo(0.6, 2);
  });
});

describe("Spring", () => {
  it("stays bounded through dropped frames at a quick response", () => {
    // The animation loop clamps dt at 50ms; a 7 Hz spring stepped at that
    // dt in one Euler step diverges (this is the bug the pointer gaze hit
    // in headless Chrome at 3.2 Hz). Every step must stay within the
    // overshoot a damped spring can physically produce.
    for (const freq of [2.2, 3.2, 7]) {
      const s = new Spring(0, freq, 0.9);
      let peak = 0;
      for (let i = 0; i < 200; i++) {
        peak = Math.max(peak, Math.abs(s.step(1, 0.05)));
      }
      expect(peak).toBeLessThan(1.2);
      expect(s.x).toBeCloseTo(1, 3);
    }
  });
});
