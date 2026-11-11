// Fixed stars (INF-3634, the captain's plan): a crewmate whose task the
// Tasks panel lists under Pinned leaves its orbit and holds a fixed place in
// the sky, lit by a glint - a soft glow and four thin tapered rays behind its
// solid, in its own light. The captain chose the constellation: a loose
// zigzag grown both ways from the upper-left diagonal, joined by a hairline
// in pin order; a corner whose room runs out hands on to the lower right, the
// upper right, then the lower left. This module owns the numbers the captain
// staged (`pinned_crew_look`, version 2) and the places; the orbit
// (./orbit.ts) eases each star there, and the painter (./crewmate.ts) draws
// the glint. The phone reads the same numbers (scripts/generate-phone-scene.ts).

import { CROWDED_PLANES } from "./orbitalPlanes";

const DEG = Math.PI / 180;

/** The captain's staged settings and the look's fixed numbers. */
export const FIXED_STARS = {
  /** Room kept between a star and the widest reach of either orbit beneath it, scene px. */
  clearOfOrbitPx: 40,
  /** A star keeps this far from the center on each axis, scene px; the stage reaches 262. */
  edgePx: 240,
  /** The long rays, up and down, in glyph heights; the side rays are `sideRay` of them. */
  rays: 1.4,
  sideRay: 0.62,
  /** A ray's half width at the solid, px. */
  rayWidth: 1.15,
  /** The glow's light at the center; it reaches one glyph out. */
  glow: 0.22,
  /** The glint's light at rest, and how far the twinkle moves light and length. */
  light: 0.82,
  twinkle: 0.5,
  twinkleLight: 0.18,
  twinkleLength: 0.12,
  /** The twinkle's pace, radians a second: one slow breath about every five seconds. */
  twinkleRate: 1.3,
  /** The glint is the crewmate's own light lifted this far toward white. */
  lift: 0.25,
  /** The joining hairline's light, and the gap it leaves round each solid in glyphs. */
  joined: true,
  joinLight: 0.34,
  joinGap: 0.7,
  /** A star's depth cue: a little nearer than the orbit's middle, so it draws in front. */
  depth: 0.62,
  /** How fast a star eases to its place and its blend eases in, per second. */
  placeRate: 6,
  blendRate: 4.5,
} as const;

/** The corners of the sky in the order they fill: upper left, lower right, upper right, lower left (screen degrees, y down). */
export const CORNERS = [-135, 45, -45, 135] as const;
/** Each star's share of the room between the orbits and the edge, alternating near and far. */
export const RHO = [
  0.4, 0.82, 0.3, 0.74, 0.46, 0.88, 0.28, 0.7, 0.42, 0.84, 0.34, 0.78, 0.4,
] as const;
/** A small turn off each star's even spacing, degrees, so the scatter reads loose. */
export const JITTER = [0, 1.5, -2, 1, -1.5, 2, -1, 0.5, -2, 1.5, 0, -1, 2] as const;
/** The widest step between neighbours in a corner, degrees, and the narrowest room a star takes, px. */
export const STEP_DEG = 12;
export const ROOM_PX = 28;
/** How far either side of its diagonal a corner reaches, degrees. */
export const REACH_DEG = 41;

/** One occupied orbit as the stars see it: its plane and the radius its idle crew sit at. */
export type StarOrbit = { plane: number; radius: number };

/** The places for `count` stars, in pin order, and the hairline joining them. */
export type SkyPlaces = {
  points: Array<{ x: number; y: number }>;
  /** Index pairs into `points`, neighbours within one corner; never between two corners. */
  joins: Array<[number, number]>;
};

/** How far orbit `plane` of `radius` reaches from the center in screen direction `theta`. */
function orbitReach(plane: number, theta: number, radius: number): number {
  const p = CROWDED_PLANES[plane];
  if (!p) return 0;
  const d = theta - p.node;
  const b = radius * Math.cos(p.inclination * DEG);
  return (radius * b) / Math.hypot(b * Math.cos(d), radius * Math.sin(d));
}

/**
 * The constellation's places for `count` stars over `orbits`, in scene px
 * from the first mate's center (screen axes, y down). Each corner's stretch
 * of sky grows out from its diagonal while there is room; past what every
 * corner holds, the two roomiest tighten.
 */
export function skyPlaces(count: number, orbits: readonly StarOrbit[]): SkyPlaces {
  if (count <= 0) return { points: [], joins: [] };
  const inner = (theta: number) =>
    orbits.reduce((reach, o) => Math.max(reach, orbitReach(o.plane, theta, o.radius)), 0) +
    FIXED_STARS.clearOfOrbitPx;
  const outer = (theta: number) =>
    FIXED_STARS.edgePx / Math.max(Math.abs(Math.cos(theta)), Math.abs(Math.sin(theta)));
  const room = (deg: number) => outer(deg * DEG) - inner(deg * DEG);
  // A place: a direction and a share of the room there; where the room runs
  // out, it slides toward its corner's diagonal.
  const sky = (start: number, rho: number) => {
    let deg = start;
    const diag = Math.round((deg - 45) / 90) * 90 + 45;
    let theta = deg * DEG;
    let lo = inner(theta);
    let hi = outer(theta);
    for (let i = 0; i < 14; i++) {
      theta = deg * DEG;
      lo = inner(theta);
      hi = outer(theta);
      if (hi - lo >= 10) break;
      deg += (diag - deg) * 0.25;
    }
    const r = lo + rho * Math.max(0, hi - lo);
    return { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
  };
  const span = (c: number, from: number, to: number): [number, number] => {
    let lo = c;
    let hi = c;
    while (lo - 2 >= from && room(lo - 2) >= ROOM_PX) lo -= 2;
    while (hi + 2 <= to && room(hi + 2) >= ROOM_PX) hi += 2;
    return [lo, hi];
  };
  const spans: Array<[number, number]> = [];
  const takes: number[] = [];
  let left = count;
  for (const c of CORNERS) {
    const first = spans[0];
    const from =
      c === -45 && first ? Math.min(c, Math.max(c - REACH_DEG, first[1] + 14)) : c - REACH_DEG;
    const to = c === -135 ? -44 : c + REACH_DEG;
    const s = span(c, from, to);
    spans.push(s);
    const take = Math.min(left, Math.floor((s[1] - s[0]) / 9) + 1);
    takes.push(take);
    left -= take;
  }
  for (let x = 0; left > 0; x++, left--) takes[x % 2] = (takes[x % 2] ?? 0) + 1;
  const points: SkyPlaces["points"] = [];
  const joins: SkyPlaces["joins"] = [];
  CORNERS.forEach((c, ci) => {
    const [lo, hi] = spans[ci] ?? [c, c];
    const take = takes[ci] ?? 0;
    if (take === 0) return;
    const step = Math.min(STEP_DEG, (hi - lo) / Math.max(1, take - 1));
    const offs: number[] = [];
    let l = 0;
    let r = 0;
    for (let j = 0; j < take; j++) {
      const canR = c + (r + 1) * step <= hi + 0.01;
      const canL = c - (l + 1) * step >= lo - 0.01;
      if (j === 0) offs.push(0);
      else if ((j % 2 === 1 && canR) || !canL) offs.push(++r);
      else offs.push(-++l);
    }
    const base = points.length;
    for (const o of offs) {
      const i = ((o % 13) + 13) % 13;
      points.push(sky(c + o * step + (JITTER[i] ?? 0) * Math.min(1, step / 8), RHO[i] ?? 0.5));
    }
    // The hairline runs across the corner, from one end of its arc to the other.
    const along = offs.map((_, i) => i).sort((a, b) => (offs[a] ?? 0) - (offs[b] ?? 0));
    for (let k = 1; k < along.length; k++)
      joins.push([base + (along[k - 1] ?? 0), base + (along[k] ?? 0)]);
  });
  return { points, joins };
}

/** The twinkle, -twinkle..twinkle, of a star with `seed` at `now` ms; zero on a settled frame. */
export function twinkleOf(seed: number, now: number, settled: boolean): number {
  if (settled) return 0;
  return FIXED_STARS.twinkle * Math.sin((now / 1000) * FIXED_STARS.twinkleRate + seed * 11);
}
