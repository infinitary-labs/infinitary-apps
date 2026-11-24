// The first mate's part in the supernova fidget (the approved preview's spec:
// "every vertex and crewmate ends where it started" and the blast's front
// stays inside the crew's canvas it is painted on).
import { describe, expect, it } from "vitest";
import { CREW_FIT } from "./crew/CrewOrbit";
import { placeSupernovaVertices, SN_SPARKS, type SnPt, SUPERNOVA, snFront } from "./supernova";

const SIZE = 280;
const C = SIZE / 2;
const R = SIZE * 0.27;
const RANK = Array.from({ length: 16 }, (_, i) => i);

function home(): SnPt[] {
  return Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return [C + Math.cos(a) * R * 0.8, C + Math.sin(a) * R * 0.8, 1, 0];
  });
}

function placed(et: number): SnPt[] {
  const pts = home();
  const dots = { scale: new Float64Array(16).fill(1), white: new Float64Array(16) };
  placeSupernovaVertices(et, RANK, pts, C, R, et * 6, new Float64Array(16), dots);
  return pts;
}

describe("the supernova's vertices", () => {
  it("sit on their own places at the start and the end", () => {
    for (const et of [0, 1]) {
      const at = placed(et);
      home().forEach((p, i) => {
        expect(at[i]?.[0], `vertex ${i} at ${et}`).toBeCloseTo(p[0], 9);
        expect(at[i]?.[1], `vertex ${i} at ${et}`).toBeCloseTo(p[1], 9);
      });
    }
  });

  it("fly out of the frame in the middle of the blast", () => {
    const at = placed(0.5);
    const out = home().map(
      (p, i) =>
        Math.hypot((at[i]?.[0] ?? C) - C, (at[i]?.[1] ?? C) - C) / Math.hypot(p[0] - C, p[1] - C),
    );
    expect(Math.min(...out)).toBeGreaterThan(1);
  });
});

describe("the blast's front", () => {
  it("runs out to its reach and never leaves the crew's square", () => {
    const edge = CREW_FIT.extentPx / 2;
    expect(snFront(0)).toBe(0);
    let peak = 0;
    for (let et = 0; et <= 1; et += 0.001) {
      const front = snFront(et) * SUPERNOVA.reachPx;
      peak = Math.max(peak, front);
      for (const s of SN_SPARKS) expect(front * s.f).toBeLessThan(edge);
    }
    expect(peak).toBeGreaterThan(SUPERNOVA.reachPx * 0.95);
    expect(peak).toBeLessThan(edge);
  });
});
