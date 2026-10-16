import { clamp01, easeInOut, TAU } from "./face";
import { mixRgb, rgba, type SkyColors, type SkyDots, type SkyPt, WHITE } from "./sky";

// Saturn: the listening form's two hexagons become the ring system - the
// outer hexagon the A ring, the inner one the B ring, with the Cassini
// division between them - and the retired square becomes the globe's cloud
// belt. The rings are an inclined ellipse (27 degrees, Saturn's tilt), the
// inner ring turns faster as Kepler says, the far half passes behind the
// globe and the near half in front of it, and the eyes keep the globe.
//
// Honesty notes: the ring radii are in proportion to the real C, B and A
// rings and the gap is the Cassini division; the ring shadow on the globe
// is placed for looks, not for a season.

export const SATURN = {
  /** Minor over major of the ring ellipse (sin of the 27 degree tilt, rounded). */
  q: 0.45,
  /** The ring plane's tilt on screen, rad. */
  tilt: -0.24,
  /** Globe radius, in units of R. */
  globe: 0.6,
  /** Where the outer hexagon sits: the A ring, in units of R. */
  ringA: 1.52,
  /** Where the inner hexagon sits: the B ring, in units of R. */
  ringB: 1.22,
  /** Angular speeds of the A ring, the B ring and the belt, rad/s: inner faster. */
  spinA: 0.55,
  spinB: 0.78,
  spinBelt: 1.15,
  /** The ring streamlines: radius in R and stroke alpha - C, B, the gap, A. */
  streamlines: [
    [0.9, 0.1],
    [0.98, 0.12],
    [1.1, 0.42],
    [1.16, 0.5],
    [1.22, 0.55],
    [1.28, 0.5],
    [1.34, 0.4],
    [1.46, 0.34],
    [1.52, 0.36],
    [1.58, 0.28],
  ] as readonly (readonly [number, number])[],
} as const;

/** The vertex layout the host hands over: the two hexagons and the square. */
export type SaturnLayout = {
  outer: readonly number[];
  inner: readonly number[];
  belt: readonly number[];
};

/** A point of the ring plane at radius `r` (units of R) and azimuth `th`, on screen. */
export function saturnPoint(
  r: number,
  th: number,
  c: number,
  R: number,
  out: [number, number],
): [number, number] {
  const x = Math.cos(th) * r * R;
  const y = Math.sin(th) * r * R * SATURN.q;
  const ct = Math.cos(SATURN.tilt);
  const st = Math.sin(SATURN.tilt);
  out[0] = c + x * ct - y * st;
  out[1] = c + x * st + y * ct;
  return out;
}

/** Whether a ring point at azimuth `th` is on the near side (in front of the globe). */
export const saturnNear = (th: number): boolean => Math.sin(th) > 0;

/**
 * Move the vertices onto the rings and the belt by the eased amount of `k`.
 * `progress[i]` reports the amount (the caller fades every wire by it);
 * dots on the far side that fall behind the globe fade out through `dots`.
 */
export function placeSaturnVertices(
  k: number,
  layout: SaturnLayout,
  pts: SkyPt[],
  c: number,
  R: number,
  tSec: number,
  progress: Float64Array,
  dots: SkyDots,
): void {
  if (k <= 0.001) return;
  const e = easeInOut(clamp01(k));
  const tmp: [number, number] = [0, 0];
  const slot = (vi: number, r: number, th: number, belt: boolean): void => {
    const p = pts[vi] as SkyPt;
    saturnPoint(r, th, c, R, tmp);
    progress[vi] = e;
    p[0] += (tmp[0] - p[0]) * e;
    p[1] += (tmp[1] - p[1]) * e;
    const near = saturnNear(th);
    p[3] += ((near ? 0.7 : -0.5) - p[3]) * e;
    // Behind the globe: the far half of the belt, and a far ring vertex
    // whose slot falls inside the globe's disc.
    const hidden = !near && (belt || Math.hypot(tmp[0] - c, tmp[1] - c) < SATURN.globe * R * 0.98);
    if (hidden) dots.fade[vi] = (dots.fade[vi] as number) * (1 - e * 0.92);
  };
  layout.outer.forEach((vi, i) => {
    slot(vi, SATURN.ringA, tSec * SATURN.spinA + (i / layout.outer.length) * TAU, false);
  });
  layout.inner.forEach((vi, i) => {
    slot(vi, SATURN.ringB, tSec * SATURN.spinB + ((i + 0.5) / layout.inner.length) * TAU, false);
  });
  layout.belt.forEach((vi, i) => {
    slot(vi, SATURN.globe * 0.97, tSec * SATURN.spinBelt + (i / layout.belt.length) * TAU, true);
  });
}

export type SaturnEnv = {
  ctx: CanvasRenderingContext2D;
  /** The envelope this frame, > 0. */
  k: number;
  c: number;
  R: number;
  size: number;
  colors: SkyColors;
};

/** One half of every streamline: the far half (behind the globe) or the near half. */
function drawRings(env: SaturnEnv, near: boolean, e: number): void {
  const { ctx, c, R, colors } = env;
  const tmp: [number, number] = [0, 0];
  const a0 = near ? Math.PI : 0;
  const a1 = near ? TAU : Math.PI;
  const SEG = 40;
  ctx.lineWidth = Math.max(1, env.size * 0.004);
  for (const [r, alpha] of SATURN.streamlines) {
    ctx.strokeStyle = rgba(mixRgb(colors.acc, WHITE, 0.25), alpha * e * colors.boost);
    ctx.beginPath();
    for (let s = 0; s <= SEG; s++) {
      saturnPoint(r, a0 + ((a1 - a0) * s) / SEG, c, R, tmp);
      if (s === 0) ctx.moveTo(tmp[0], tmp[1]);
      else ctx.lineTo(tmp[0], tmp[1]);
    }
    ctx.stroke();
  }
}

/**
 * Painted BEFORE the crisp geometry: the far half of the rings, then the
 * globe - the app background swallowing them, a soft limb, two cloud belts
 * and the ring shadow - so the wires and dots in front of the globe really
 * are in front of it.
 */
export function drawSaturnUnder(env: SaturnEnv): void {
  const { ctx, k, c, R, colors } = env;
  const e = easeInOut(clamp01(k));
  if (e <= 0.01) return;
  ctx.save();
  drawRings(env, false, e);
  const gr = SATURN.globe * R;
  ctx.fillStyle = rgba(colors.bg, 0.94 * e);
  ctx.beginPath();
  ctx.arc(c, c, gr, 0, TAU);
  ctx.fill();
  const limb = ctx.createRadialGradient(c, c, gr * 0.55, c, c, gr);
  limb.addColorStop(0, rgba(colors.acc, 0));
  limb.addColorStop(1, rgba(colors.acc, 0.16 * e * colors.boost));
  ctx.fillStyle = limb;
  ctx.beginPath();
  ctx.arc(c, c, gr, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(mixRgb(colors.acc, colors.dim, 0.35), 0.7 * e * colors.boost);
  ctx.lineWidth = Math.max(1.2, env.size * 0.0046);
  ctx.beginPath();
  ctx.arc(c, c, gr, 0, TAU);
  ctx.stroke();
  // Two cloud belts, curving with the globe.
  ctx.strokeStyle = rgba(colors.dim, 0.5 * e * colors.boost);
  ctx.lineWidth = Math.max(1, env.size * 0.0036);
  ctx.beginPath();
  ctx.ellipse(c, c - gr * 0.38, gr * 0.92, gr * 0.16, SATURN.tilt, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(c, c + gr * 0.42, gr * 0.9, gr * 0.16, SATURN.tilt, Math.PI * 0.1, Math.PI * 0.9);
  ctx.stroke();
  // The ring shadow across the globe's lower half, clipped to the disc.
  ctx.beginPath();
  ctx.arc(c, c, gr - 0.6, 0, TAU);
  ctx.clip();
  ctx.strokeStyle = rgba(colors.bg, 0.7 * e);
  ctx.lineWidth = gr * 0.3;
  ctx.beginPath();
  ctx.ellipse(c, c, R * 1.34, R * 1.34 * SATURN.q, SATURN.tilt, Math.PI * 0.95, Math.PI * 1.5);
  ctx.stroke();
  ctx.restore();
}

/** Painted AFTER the crisp geometry: the near half of the rings, in front of the globe. */
export function drawSaturnOver(env: SaturnEnv): void {
  const e = easeInOut(clamp01(env.k));
  if (e <= 0.01) return;
  env.ctx.save();
  drawRings(env, true, e);
  env.ctx.restore();
}
