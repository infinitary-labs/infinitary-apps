import { describe, expect, it } from "vitest";
import { ALGOL, algolDim, algolEye, algolPhase } from "./algol";

const SIZE = 280;
const C = SIZE / 2;
const R = SIZE * 0.27;
const TAU = Math.PI * 2;

/** The emote progress at which the orbit reaches `phase`, inverting the eased schedule. */
function etAt(phase: number): number {
  const target = phase / (TAU * ALGOL.orbits);
  let lo = 0.1;
  let hi = 0.9;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (algolPhase(mid) / (TAU * ALGOL.orbits) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe("Algol's orbit", () => {
  it("dips the whole light by the eclipse depth at mid-eclipse and not at quadrature", () => {
    expect(algolDim(1, etAt(Math.PI / 2))).toBeCloseTo(1 - ALGOL.dip, 6);
    expect(algolDim(1, etAt(Math.PI))).toBeCloseTo(1, 6);
    // No envelope, no dip.
    expect(algolDim(0, etAt(Math.PI / 2))).toBe(1);
  });
});

describe("Algol's eyes", () => {
  const base = (side: number): [number, number] => [C + side * R * 0.34, C - R * 0.1];

  it("stay at rest outside the emote", () => {
    for (const side of [-1, 1]) {
      const e = algolEye(0, side, base(side), C, R, 0.5);
      expect(e).toEqual({ x: base(side)[0], y: base(side)[1], depthMul: 1, alpha: 1, z: 0 });
    }
  });

  it("cover the far eye at mid-eclipse and leave both lit at quadrature", () => {
    const eclipse = etAt(Math.PI / 2);
    const front = algolEye(1, 1, base(1), C, R, eclipse);
    const back = algolEye(1, -1, base(-1), C, R, eclipse);
    expect(front.alpha).toBeCloseTo(1, 6);
    expect(back.alpha).toBeCloseTo(1 - ALGOL.cover, 6);
    // Aligned in x: one in front of the other.
    expect(Math.abs(front.x - back.x)).toBeLessThan(1e-6);
    const quadrature = etAt(Math.PI);
    for (const side of [-1, 1]) {
      expect(algolEye(1, side, base(side), C, R, quadrature).alpha).toBeCloseTo(1, 6);
    }
    // Half a turn on, the other eye is the covered one.
    const second = etAt((3 * Math.PI) / 2);
    expect(algolEye(1, 1, base(1), C, R, second).alpha).toBeCloseTo(1 - ALGOL.cover, 6);
    expect(algolEye(1, -1, base(-1), C, R, second).alpha).toBeCloseTo(1, 6);
  });
});
