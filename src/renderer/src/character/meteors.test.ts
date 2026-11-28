// The first mate's part in the meteor fidgets (the captain's ask: "a meteor
// shower fidget animation ... it should look visually pleasing and inspire a
// sense of awe", and on the storm's preview: "the first mate can just fade").
import { describe, expect, it } from "vitest";
import {
  METEOR_SCHEDULE,
  METEORS,
  type MeteorVariant,
  meteorBody,
  meteorEyes,
  meteorLights,
  placeStormVertices,
  SHOWER_METEORS,
  STORM_DIR,
  stormFlights,
} from "./meteors";

const SIZE = 280;
const C = SIZE / 2;
const R = SIZE * 0.27;
const RANK = Array.from({ length: 16 }, (_, i) => i);
const VARIANTS: MeteorVariant[] = ["shower", "storm", "fireball"];

function frame(): number[][] {
  return Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return [C + Math.cos(a) * R * 0.8, C + Math.sin(a) * R * 0.8];
  });
}

function storm(et: number) {
  const pts = frame();
  const progress = new Float64Array(16);
  const dots = {
    scale: new Float64Array(16).fill(1),
    fade: new Float64Array(16).fill(1),
    white: new Float64Array(16),
  };
  const home = new Float64Array(32);
  placeStormVertices(et, RANK, pts, C, progress, dots, home);
  return { pts, progress, dots, home };
}

describe("the storm's frame", () => {
  it("fades where it stands from 4% to 16% of the storm, with no point flying off", () => {
    expect([...storm(0.04).progress]).toEqual(new Array(16).fill(0));
    expect([...storm(0.16).progress]).toEqual(new Array(16).fill(1));
    expect([...storm(0.16).dots.fade]).toEqual(new Array(16).fill(0));
    for (let et = 0; et <= METEOR_SCHEDULE.landAt; et += 0.005) {
      const { home } = storm(et);
      expect(stormFlights(et, RANK, home), `at ${et}`).toEqual([]);
    }
  });

  it("rains each point home onto its own place", () => {
    const { home } = storm(0.7);
    const flying = stormFlights(0.7, RANK, home);
    expect(flying.length).toBeGreaterThan(0);
    for (const f of flying) {
      // Each falls along the storm's heading toward where the first mate drew it,
      // to the millionth the tables are kept to (meteors.ts, onGrid).
      const dx = (home[2 * f.i] ?? 0) - f.x;
      const dy = (home[2 * f.i + 1] ?? 0) - f.y;
      const d = Math.hypot(dx, dy);
      expect(d, `point ${f.i}`).toBeGreaterThan(0);
      expect((dx * STORM_DIR[0] + dy * STORM_DIR[1]) / d, `point ${f.i}`).toBeCloseTo(1, 5);
    }
    const late = stormFlights(0.9, RANK, home);
    expect(late).toEqual([]);
  });

  it("is whole again by 90% of the storm, its last glint gone by 92%", () => {
    for (const et of [0.9, 0.95, 1]) {
      const { progress } = storm(et);
      expect([...progress], `at ${et}`).toEqual(new Array(16).fill(0));
    }
    for (const et of [0.92, 0.96, 1]) {
      const { dots } = storm(et);
      expect([...dots.fade], `at ${et}`).toEqual(new Array(16).fill(1));
      expect([...dots.white], `at ${et}`).toEqual(new Array(16).fill(0));
      expect([...dots.scale], `at ${et}`).toEqual(new Array(16).fill(1));
    }
  });
});

describe("each meteor fidget", () => {
  for (const v of VARIANTS) {
    it(`${v} ends with the first mate exactly at rest`, () => {
      const body = meteorBody(v, 1);
      expect(body).toEqual({ hush: 0, spin: 1, follow: 0, wish: 0 });
      const watch = meteorLights(v, 1).watch;
      const eyes = meteorEyes(v, 1, watch, null, R);
      expect(eyes.look).toEqual([0, 0]);
      expect(eyes.lid).toBe(0);
      expect(eyes.wide).toBe(1);
      expect(eyes.happy).toBe(0);
    });

    it(`${v} casts no light beyond the sky's ${METEORS.reachPx} px reach`, () => {
      for (let et = 0; et <= 1; et += 0.002) {
        for (const l of meteorLights(v, et).lights) {
          expect(Math.hypot(l.x, l.y), `${v} at ${et}`).toBeLessThan(METEORS.reachPx);
        }
      }
    });
  }

  it("lights the sky at its height for the eyes to follow", () => {
    for (const v of VARIANTS) {
      let peak = 0;
      for (let et = 0; et <= 1; et += 0.002) peak = Math.max(peak, meteorLights(v, et).watch.v);
      expect(peak, v).toBeGreaterThan(0.45);
    }
  });
});

describe("the shower", () => {
  it("runs every meteor straight away from its radiant", () => {
    const rx = METEOR_SCHEDULE.radiant[0] * METEORS.reachPx;
    const ry = METEOR_SCHEDULE.radiant[1] * METEORS.reachPx;
    // The brightest, last, crosses the sky on its own path. The tables are kept
    // to the millionth (meteors.ts, onGrid), so the line holds to five places.
    for (const m of SHOWER_METEORS.slice(0, -1)) {
      const dx = m.x0 - rx;
      const dy = m.y0 - ry;
      const d = Math.hypot(dx, dy);
      expect((dx * m.uy - dy * m.ux) / d).toBeCloseTo(0, 5);
      expect(dx * m.ux + dy * m.uy).toBeGreaterThan(-m.L / 2);
    }
  });

  it("has one meteor brighter than the rest, and bows once for a wish", () => {
    const mags = SHOWER_METEORS.map((m) => m.mag);
    expect(mags.filter((m) => m >= Math.max(...mags))).toHaveLength(1);
    let wished = 0;
    for (let et = 0; et <= 1; et += 0.002) wished = Math.max(wished, meteorBody("shower", et).wish);
    expect(wished).toBeGreaterThan(0.9);
    expect(meteorBody("storm", METEOR_SCHEDULE.wishAt + 0.05).wish).toBe(0);
  });
});
