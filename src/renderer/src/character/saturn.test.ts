import { describe, expect, it } from "vitest";
import { placeSaturnVertices, SATURN, type SaturnLayout, saturnNear, saturnPoint } from "./saturn";
import type { SkyDots, SkyPt } from "./sky";

const SIZE = 280;
const C = SIZE / 2;
const R = SIZE * 0.27;

// The listening form's rings as Firstmate.tsx hands them over.
const LAYOUT: SaturnLayout = {
  outer: [0, 1, 5, 4, 12, 8],
  inner: [9, 11, 10, 14, 15, 13],
  belt: [2, 3, 7, 6],
};

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

/** Undo the ring plane's tilt and flattening: the ring radius a screen point sits at, in R. */
function ringRadius(x: number, y: number): number {
  const dx = x - C;
  const dy = y - C;
  const ct = Math.cos(-SATURN.tilt);
  const st = Math.sin(-SATURN.tilt);
  const ux = dx * ct - dy * st;
  const uy = (dx * st + dy * ct) / SATURN.q;
  return Math.hypot(ux, uy) / R;
}

describe("Saturn's ring system", () => {
  it("keeps the Cassini division: the B ring ends inside the A ring's start", () => {
    const radii = SATURN.streamlines.map(([r]) => r);
    expect(SATURN.ringB).toBeLessThan(SATURN.ringA);
    // A gap of at least 0.1R between the B ring's last streamline and the A ring's first.
    const b = radii.filter((r) => r <= SATURN.ringB + 0.13);
    const a = radii.filter((r) => r >= SATURN.ringA - 0.07);
    expect(Math.min(...a) - Math.max(...b)).toBeGreaterThanOrEqual(0.1);
    // The globe sits inside the innermost streamline.
    expect(SATURN.globe).toBeLessThan(Math.min(...radii));
  });

  it("puts the outer hexagon on the A ring, the inner on the B ring and the square on the globe", () => {
    const pts = scattered();
    const progress = new Float64Array(16);
    placeSaturnVertices(1, LAYOUT, pts, C, R, 0.7, progress, dots());
    for (const v of LAYOUT.outer) {
      const p = pts[v] as SkyPt;
      expect(ringRadius(p[0], p[1])).toBeCloseTo(SATURN.ringA, 5);
    }
    for (const v of LAYOUT.inner) {
      const p = pts[v] as SkyPt;
      expect(ringRadius(p[0], p[1])).toBeCloseTo(SATURN.ringB, 5);
    }
    for (const v of LAYOUT.belt) {
      const p = pts[v] as SkyPt;
      expect(ringRadius(p[0], p[1])).toBeCloseTo(SATURN.globe * 0.97, 5);
    }
    for (let i = 0; i < 16; i++) expect(progress[i]).toBeCloseTo(1, 6);
  });

  it("hides the belt's far half behind the globe and shows its near half", () => {
    // At tSec = 0.1 the belt's four slots sit a few degrees past 0, 90, 180
    // and 270: two on the near side (sin > 0), two on the far side, behind
    // the globe.
    const pts = scattered();
    const d = dots();
    placeSaturnVertices(1, LAYOUT, pts, C, R, 0.1, new Float64Array(16), d);
    const fades = LAYOUT.belt.map((v) => d.fade[v] as number);
    expect(fades.filter((f) => f < 0.2)).toHaveLength(2);
    expect(fades.filter((f) => f > 0.9)).toHaveLength(2);
    // A ring vertices never hide: the A ring's far side clears the globe.
    for (const v of LAYOUT.outer) expect(d.fade[v]).toBe(1);
    // B ring vertices hide exactly when their far-side slot falls behind the
    // globe's disc (the ellipse's top passes inside it), and never in front.
    LAYOUT.inner.forEach((v, i) => {
      const th = 0.1 * SATURN.spinB + ((i + 0.5) / LAYOUT.inner.length) * Math.PI * 2;
      const [x, y] = saturnPoint(SATURN.ringB, th, C, R, [0, 0]);
      const behind = !saturnNear(th) && Math.hypot(x - C, y - C) < SATURN.globe * R * 0.98;
      expect((d.fade[v] as number) < 0.2, `vertex ${v}`).toBe(behind);
    });
    expect(LAYOUT.inner.filter((v) => (d.fade[v] as number) < 0.2).length).toBeGreaterThan(0);
  });

  it("does nothing before the envelope rises", () => {
    const pts = scattered();
    const before = pts.map((p) => [...p]);
    const progress = new Float64Array(16);
    placeSaturnVertices(0, LAYOUT, pts, C, R, 3, progress, dots());
    expect(pts).toEqual(before);
    expect(Array.from(progress)).toEqual(new Array(16).fill(0));
  });
});
