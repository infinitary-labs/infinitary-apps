import { clamp01, easeInOut, TAU } from "./face";
import { rgba, type SkyColors } from "./sky";

// Algol, the Demon Star: two stars eclipsing each other every 2.87 days.
// Here the eyes are the pair. They leave their places in the inner cell for
// an orbit around their midpoint seen almost edge on, one passes in front of
// the other twice a turn, the eye behind fades while it is covered, and the
// whole character's light dips at each eclipse - the wink the star is named
// for. The structure itself only carries a faint dashed orbit.
//
// Honesty notes: Algol's real dip is about 1.3 magnitudes; here the light
// drops by about a third, and two orbits stand in for the 2.87 day period.

export const ALGOL = {
  /** Orbits over the hold. */
  orbits: 2,
  /** Orbit semi-major axis, in units of R: the eyes' resting half-separation. */
  sep: 0.34,
  /** Minor over major of the orbit on screen: almost edge on. */
  flatten: 0.22,
  /** How much of the whole character's light an eclipse takes. */
  dip: 0.35,
  /** How much of the covered eye's light an eclipse takes. */
  cover: 0.8,
  /** The eyes' resting height above the character's center, in units of R. */
  eyeRise: 0.1,
} as const;

/** The orbit's phase at emote progress `et`: eased in and out, `orbits` turns over the hold. */
export const algolPhase = (et: number): number =>
  easeInOut(clamp01((et - 0.1) / 0.8)) * TAU * ALGOL.orbits;

/** How aligned the pair is along the line of sight: 1 at mid-eclipse, 0 at quadrature. */
export const algolAlignment = (phase: number): number =>
  Math.max(0, 1 - Math.abs(Math.cos(phase)) * 3) ** 2;

/** The whole character's light this frame, 1 = full, for envelope `k`. */
export const algolDim = (k: number, et: number): number =>
  1 - ALGOL.dip * algolAlignment(algolPhase(et)) * easeInOut(clamp01(k));

export type AlgolEye = {
  x: number;
  y: number;
  /** Size factor: the nearer star of the pair reads a touch larger. */
  depthMul: number;
  /** Light factor: the covered star fades. */
  alpha: number;
  /** Draw order: larger is nearer the viewer and painted last. */
  z: number;
};

/**
 * Where an eye goes during the emote: from its resting `base` onto the
 * orbit by the envelope. `side` is -1 for the left eye and 1 for the right,
 * half a turn apart. Outside the emote (k ~ 0) the base comes back unchanged.
 */
export function algolEye(
  k: number,
  side: number,
  base: readonly [number, number],
  c: number,
  R: number,
  et: number,
): AlgolEye {
  if (k <= 0.001) return { x: base[0], y: base[1], depthMul: 1, alpha: 1, z: 0 };
  const e = easeInOut(clamp01(k));
  const phase = algolPhase(et);
  const front = Math.sin(phase) * side;
  const ox = c + Math.cos(phase) * ALGOL.sep * R * side;
  const oy = c - ALGOL.eyeRise * R + Math.sin(phase) * ALGOL.sep * R * ALGOL.flatten * side;
  const align = algolAlignment(phase);
  return {
    x: base[0] + (ox - base[0]) * e,
    y: base[1] + (oy - base[1]) * e,
    depthMul: 1 + 0.12 * front * e,
    alpha: 1 - (front < 0 ? ALGOL.cover * align * e : 0),
    z: front * e,
  };
}

export type AlgolEnv = {
  ctx: CanvasRenderingContext2D;
  /** The envelope this frame, > 0. */
  k: number;
  c: number;
  R: number;
  size: number;
  colors: SkyColors;
};

/** Painted BEFORE the crisp geometry: the pair's orbit, a faint dashed ellipse. */
export function drawAlgolUnder(env: AlgolEnv): void {
  const { ctx, k, c, R, colors } = env;
  const e = easeInOut(clamp01(k));
  if (e <= 0.02) return;
  ctx.save();
  ctx.strokeStyle = rgba(colors.dim, 0.4 * e * colors.boost);
  ctx.lineWidth = Math.max(1, env.size * 0.0036);
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.ellipse(c, c - ALGOL.eyeRise * R, ALGOL.sep * R, ALGOL.sep * R * ALGOL.flatten, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
}
