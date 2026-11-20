import { describe, expect, it } from "vitest";
import { GALAXY, galaxyArmPoint, galaxySlot, galaxySpin, placeGalaxyVertices } from "./galaxy";
import type { SkyDots, SkyPt } from "./sky";

const SIZE = 280;
const C = SIZE / 2;
const R = SIZE * 0.27;

function scattered(): SkyPt[] {
  const pts: SkyPt[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push([C + Math.cos(a) * R * 0.8, C + Math.sin(a) * R * 0.8, 1, 0]);
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

/** Undo the disc's tilt and flattening: the disc radius a screen point sits at, in R. */
function discRadius(x: number, y: number): number {
  const dx = x - C;
  const dy = y - C;
  const ct = Math.cos(-GALAXY.tilt);
  const st = Math.sin(-GALAXY.tilt);
  const ux = dx * ct - dy * st;
  const uy = (dx * st + dy * ct) / GALAXY.q;
  return Math.hypot(ux, uy) / R;
}

describe("the spiral galaxy's arms", () => {
  it("turn with the spin without changing their radius (the prototype's bug, pinned)", () => {
    // A spin folded into the exponent shrank the arms to nothing as the
    // clock ran; the spin must move a point around the disc, never inward.
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    for (const spin of [0, -1, -10, galaxySpin(4000)]) {
      galaxyArmPoint(1, 2, spin, C, R, a);
      galaxyArmPoint(1, 2, 0, C, R, b);
      expect(discRadius(a[0], a[1])).toBeCloseTo(discRadius(b[0], b[1]), 6);
    }
    galaxyArmPoint(1, 2, 0, C, R, a);
    galaxyArmPoint(1, 2, -1, C, R, b);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(R * 0.5);
  });
});

describe("the vertices on the arms", () => {
  it("settle exactly on their arm slots at full envelope, inner slots first", () => {
    const tSec = 12.5;
    const pts = scattered();
    const progress = new Float64Array(16);
    const d = dots();
    placeGalaxyVertices(1, pts, C, R, tSec, progress, d);
    const out: [number, number] = [0, 0];
    for (let i = 0; i < 16; i++) {
      const { arm, th } = galaxySlot(i);
      galaxyArmPoint(arm, th, galaxySpin(tSec), C, R, out);
      const p = pts[i] as SkyPt;
      expect(Math.hypot(p[0] - out[0], p[1] - out[1])).toBeLessThan(1e-6);
      expect(progress[i]).toBeCloseTo(1, 6);
      // Dots grow toward the bulge.
      expect(d.scale[i]).toBeGreaterThanOrEqual(1);
    }
    expect(d.scale[0]).toBeGreaterThan(d.scale[14] as number);
    const early = new Float64Array(16);
    placeGalaxyVertices(0.35, scattered(), C, R, tSec, early, dots());
    expect(early[0]).toBeGreaterThan(early[14] as number);
    expect(early[14]).toBe(0);
  });

  it("do nothing before the envelope rises", () => {
    const pts = scattered();
    const before = pts.map((p) => [...p]);
    const progress = new Float64Array(16);
    placeGalaxyVertices(0, pts, C, R, 9, progress, dots());
    expect(pts).toEqual(before);
    expect(Array.from(progress)).toEqual(new Array(16).fill(0));
  });
});
