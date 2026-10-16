import { describe, expect, it } from "vitest";
import {
  BIG_DIPPER,
  type Constellation,
  ORION,
  placeConstellationVertices,
  starPoint,
} from "./constellations";
import type { SkyDots, SkyPt } from "./sky";

// The character's stage: a 280 px canvas, R = size * 0.27, as Firstmate.tsx
// projects it.
const SIZE = 280;
const C = SIZE / 2;
const R = SIZE * 0.27;

/** Sixteen vertices scattered around the center, as if projected. */
function scattered(): SkyPt[] {
  const pts: SkyPt[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push([C + Math.cos(a) * R * 0.8, C + Math.sin(a) * R * 0.8, 1, i % 2 ? 0.5 : -0.5]);
  }
  return pts;
}

function dots(): SkyDots {
  return {
    scale: new Float64Array(16).fill(1),
    fade: new Float64Array(16).fill(1),
    white: new Float64Array(16),
  };
}

const figures: [string, Constellation][] = [
  ["Orion", ORION],
  ["the Big Dipper", BIG_DIPPER],
];

describe.each(figures)("%s", (_name, con) => {
  it("gives every vertex a star, every star a magnitude, and every line two stars", () => {
    expect(con.slots).toHaveLength(16);
    expect(con.order).toHaveLength(16);
    expect(new Set(con.order).size).toBe(16);
    for (const si of con.slots) expect(con.stars[si]).toBeDefined();
    for (const s of con.stars) expect(s.mag).toBeGreaterThanOrEqual(0);
    for (const [p, q] of con.lines) {
      expect(con.stars[p]).toBeDefined();
      expect(con.stars[q]).toBeDefined();
    }
  });

  it("leaves the vertices alone before the envelope rises", () => {
    const pts = scattered();
    const before = pts.map((p) => [...p]);
    const progress = new Float64Array(16).fill(0.5);
    placeConstellationVertices(0, con, pts, C, R, 1, progress, dots());
    expect(pts).toEqual(before);
    // Nothing written: the caller's array is its own.
    expect(Array.from(progress)).toEqual(new Array(16).fill(0.5));
  });

  it("settles every vertex on its star at full envelope, and says so", () => {
    const pts = scattered();
    const progress = new Float64Array(16);
    const d = dots();
    placeConstellationVertices(1, con, pts, C, R, 1, progress, d);
    const out: [number, number] = [0, 0];
    for (let i = 0; i < 16; i++) {
      starPoint(con, con.slots[i] as number, C, R, out);
      expect(Math.hypot((pts[i] as SkyPt)[0] - out[0], (pts[i] as SkyPt)[1] - out[1])).toBeLessThan(
        1e-6,
      );
      expect(progress[i]).toBeCloseTo(1, 6);
      // A settled star reads as the near, bright family.
      expect((pts[i] as SkyPt)[3]).toBeCloseTo(0.7, 6);
    }
  });

  it("settles in rank order: the first of the order moves before the last", () => {
    const pts = scattered();
    const progress = new Float64Array(16);
    placeConstellationVertices(0.35, con, pts, C, R, 1, progress, dots());
    const first = con.order[0] as number;
    const last = con.order[15] as number;
    expect(progress[first]).toBeGreaterThan(progress[last] as number);
    expect(progress[last]).toBe(0);
  });
});
