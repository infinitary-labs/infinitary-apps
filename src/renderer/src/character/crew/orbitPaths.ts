// The crew orbit's geometry, px from the Firstmate's center: the curve a
// remote spark, fall home or packet flies between the Firstmate and a slot,
// the easings its clips travel with, and an orbit's ellipse as the painter
// traces it. Pure arithmetic; the orbit model (./orbit.ts) decides who
// travels which path, and when.

export type Point = { x: number; y: number };
/** A cubic curve in screen space, px from the Firstmate's center. */
export type Arc = { from: Point; c1: Point; c2: Point; to: Point };

/**
 * Where a crewmate's slot or a program's mark sits in scene space, before a
 * remote cluster's projection, and the radius of the orbit it rides.
 */
export type SceneSlot = { x: number; y: number; z: number; depth: number; radius: number };

/**
 * An orbit as the crew travel it on screen: an ellipse around `x, y` with
 * semi-axes `major` and `minor`, its major axis at `angle` radians, px from
 * the Firstmate's center.
 */
export type OrbitPath = { x: number; y: number; major: number; minor: number; angle: number };

export const easeIn = (t: number): number => t * t;
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * A curved path from `from` to `to` that leaves tangentially, the way the
 * home spark swirls out of the core; `side` (1 or -1) picks which way it
 * bends. Both ends may move: the spark re-aims at its live slot.
 */
export function arcBetween(from: Point, to: Point, side: 1 | -1): Arc {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const nx = -uy;
  const ny = ux;
  const swing = side * 0.8;
  return {
    from,
    c1: {
      x: from.x + (ux * Math.cos(swing) + nx * Math.sin(swing)) * d * 0.38,
      y: from.y + (uy * Math.cos(swing) + ny * Math.sin(swing)) * d * 0.38,
    },
    c2: {
      x: to.x - ux * d * 0.22 + nx * side * d * 0.1,
      y: to.y - uy * d * 0.22 + ny * side * d * 0.1,
    },
    to,
  };
}

/** The point `s` (0..1) of the way along an arc. */
export function alongArc(arc: Arc, s: number): Point {
  const u = 1 - s;
  const w0 = u * u * u;
  const w1 = 3 * u * u * s;
  const w2 = 3 * u * s * s;
  const w3 = s * s * s;
  return {
    x: w0 * arc.from.x + w1 * arc.c1.x + w2 * arc.c2.x + w3 * arc.to.x,
    y: w0 * arc.from.y + w1 * arc.c1.y + w2 * arc.c2.y + w3 * arc.to.y,
  };
}

/** A direction of length one, for a cue; the origin looks right. */
export function unit(point: Point): Point {
  const len = Math.hypot(point.x, point.y);
  return len > 0 ? { x: point.x / len, y: point.y / len } : { x: 1, y: 0 };
}

/**
 * The ellipse `centre + u cos t + v sin t` by its axes. A blend of the ring
 * and a plane leaves `u` and `v` oblique, so the axes come from the
 * ellipse's own shape: the eigenvalues of u uᵀ + v vᵀ are the squared
 * semi-axes, and its leading eigenvector is the major axis.
 */
export function ellipseOf(centre: Point, u: Point, v: Point): OrbitPath {
  const xx = u.x * u.x + v.x * v.x;
  const yy = u.y * u.y + v.y * v.y;
  const xy = u.x * u.y + v.x * v.y;
  const mid = (xx + yy) / 2;
  const spread = Math.hypot((xx - yy) / 2, xy);
  return {
    x: centre.x,
    y: centre.y,
    major: Math.sqrt(mid + spread),
    minor: Math.sqrt(Math.max(0, mid - spread)),
    angle: Math.atan2(2 * xy, xx - yy) / 2,
  };
}
