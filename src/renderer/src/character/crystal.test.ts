import { describe, expect, it } from "vitest";
import {
  answerBand,
  bandLight,
  bankedHeat,
  CR,
  CRYSTAL_ANSWER_MS,
  type CrLayout,
  type CrPt,
  climbingBand,
  crystalEdges,
  crystalPose,
  placeCrystalVertices,
  projectCrystal,
} from "./crystal";

// The listening form's rings as firstmatePainter.ts hands them over.
const LAYOUT: CrLayout = {
  equator: [0, 1, 5, 4, 12, 8],
  inner: [9, 11, 10, 14, 15, 13],
  apexes: [2, 3],
  sinks: [7, 6],
};

describe("the crystal's form", () => {
  it("is a hexagonal bipyramid with an inner ring: 24 edges, 14 vertices", () => {
    const edges = crystalEdges(LAYOUT);
    expect(edges).toHaveLength(24);
    const used = new Set(edges.flat());
    expect(used.size).toBe(14);
    for (const sink of LAYOUT.sinks) expect(used.has(sink)).toBe(false);
    for (const v of LAYOUT.equator) {
      for (const apex of LAYOUT.apexes) {
        expect(edges.some(([p, q]) => (p === v && q === apex) || (p === apex && q === v))).toBe(
          true,
        );
      }
    }
  });

  it("stands the apexes on the axis, upper above lower, within the character's canvas", () => {
    const pose = crystalPose(LAYOUT, 12.3);
    const [top, bottom] = LAYOUT.apexes.map((v) => pose.get(v) as [number, number, number]);
    expect(top?.[0]).toBeCloseTo(0, 9);
    expect(bottom?.[0]).toBeCloseTo(0, 9);
    const size = 300;
    const R = size * 0.27;
    const upper = projectCrystal(top as [number, number, number], size / 2, R);
    const lower = projectCrystal(bottom as [number, number, number], size / 2, R);
    expect(upper.y).toBeLessThan(lower.y);
    expect(upper.y).toBeGreaterThan(size * 0.05);
    expect(lower.y).toBeLessThan(size * 0.95);
    // The e2e reads the upper apex here.
    expect((size / 2 - upper.y) / R).toBeCloseTo(1.258, 2);
  });

  it("moves no vertex at k 0 and lands every vertex on its slot at k 1", () => {
    const c = 150;
    const R = 81;
    const start = (): CrPt[] => Array.from({ length: 16 }, (_, i) => [i, i * 2, 1, 0] as CrPt);
    const untouched = start();
    placeCrystalVertices(0, LAYOUT, untouched, c, R, 3, new Float64Array(16));
    expect(untouched).toEqual(start());
    const pts = start();
    const depth = new Float64Array(16);
    placeCrystalVertices(1, LAYOUT, pts, c, R, 3, depth);
    const pose = crystalPose(LAYOUT, 3);
    for (const [v, p] of pose) {
      const s = projectCrystal(p, c, R);
      expect(pts[v]?.[0]).toBeCloseTo(s.x, 9);
      expect(pts[v]?.[1]).toBeCloseTo(s.y, 9);
    }
    // The upper apex leans toward the viewer (we look from a little above).
    expect(depth[2]).toBeGreaterThan(0.5);
    expect(depth[3]).toBeLessThan(0.5);
  });
});

describe("the crystal's light", () => {
  it("banks the ember at half: the wires give it up, the eyes and cores keep half", () => {
    expect(bankedHeat(1, 1)).toEqual({ wire: 0, core: 0.5 });
    expect(bankedHeat(1, 0)).toEqual({ wire: 1, core: 1 });
    expect(bankedHeat(0, 1)).toEqual({ wire: 0, core: 0 });
  });

  it("climbs from the lower apex to the upper once per period, dark at both ends", () => {
    expect(bandLight(0, climbingBand(0))).toBeLessThan(0.05);
    expect(bandLight(0.5, climbingBand(CR.bandPeriod / 2))).toBeCloseTo(1, 1);
    expect(climbingBand(CR.bandPeriod * 0.25)).toBeLessThan(climbingBand(CR.bandPeriod * 0.75));
    expect(climbingBand(1.1)).toBeCloseTo(climbingBand(1.1 + CR.bandPeriod * 7), 9);
    expect(bandLight(1, climbingBand(CR.bandPeriod - 1e-6))).toBeLessThan(0.05);
  });

  it("brings the answer down once and then goes dark", () => {
    const early = answerBand(0) as number;
    const late = answerBand(CRYSTAL_ANSWER_MS * 0.9) as number;
    expect(early).toBeGreaterThan(late);
    expect(early).toBeGreaterThan(1);
    expect(answerBand(CRYSTAL_ANSWER_MS)).toBeNull();
    expect(answerBand(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
