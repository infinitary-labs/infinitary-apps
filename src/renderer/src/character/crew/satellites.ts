import { DEPENDENCY_VISUAL } from "@shared/dependencyVisual";
import { CROWDED_PLANES } from "./orbitalPlanes";

/**
 * A waiting crewmate's own circle, in the blocker's orbital frame
 * (captain's FI3-1680 choice). The circle is spanned by the blocker's
 * radial spoke and its main plane's normal, so the two planes meet at 90°
 * and the shared spoke turns with the blocker. Radius is scene pixels,
 * before the stage's existing fit.
 */

type Vec3 = [number, number, number];

/** Half the home formation's square, scene px. Remote clusters scale after this. */
export const SCENE_HALF_PX = 280;
const SCENE_MARGIN_PX = 18;
/** How far from the center a seat off the slot may sit, scene px, each axis. */
export const SCENE_REACH_PX = SCENE_HALF_PX - SCENE_MARGIN_PX;

export function planeAxes(plane: number, angle: number): { radial: Vec3; normal: Vec3 } {
  const p = CROWDED_PLANES[plane];
  if (!p) throw new Error("Unknown orbital plane");
  const inclination = (p.inclination * Math.PI) / 180;
  const c = Math.cos(p.node);
  const s = Math.sin(p.node);
  const radial: Vec3 = [
    c * Math.cos(angle) - s * Math.cos(inclination) * Math.sin(angle),
    s * Math.cos(angle) + c * Math.cos(inclination) * Math.sin(angle),
    Math.sin(inclination) * Math.sin(angle),
  ];
  const normal: Vec3 = [
    s * Math.sin(inclination),
    -c * Math.sin(inclination),
    Math.cos(inclination),
  ];
  return { radial, normal };
}

/** Offset from the blocker, in the same scene space as `projectPlane`. */
export function satelliteOffset(
  plane: number,
  angle: number,
  phase: number,
  radius: number = DEPENDENCY_VISUAL.radiusPx,
): Vec3 {
  const { radial, normal } = planeAxes(plane, angle);
  return [
    radius * (radial[0] * Math.cos(phase) + normal[0] * Math.sin(phase)),
    radius * (radial[1] * Math.cos(phase) + normal[1] * Math.sin(phase)),
    radius * (radial[2] * Math.cos(phase) + normal[2] * Math.sin(phase)),
  ];
}

/** Even seats, plus travel on the stage clock. A settled frame does not travel. */
export function satellitePhase(
  index: number,
  count: number,
  now: number,
  settled: boolean,
): number {
  const travel = settled ? 0 : (now / 1000) * (Math.PI / 180) * DEPENDENCY_VISUAL.degPerSec;
  return 1.2 + (index / Math.max(1, count)) * Math.PI * 2 + travel;
}

/**
 * The circle's radius around a blocker at `origin`: the full radius, or the
 * largest smaller one whose whole circle stays inside the home square, so a
 * waiter near the edge keeps circling on a tighter circle and never leaves it
 * (captain's INF-1532 choice A). Zero when the blocker itself is past the reach.
 */
export function satelliteRadius(
  plane: number,
  angle: number,
  origin: { x: number; y: number },
): number {
  const { radial, normal } = planeAxes(plane, angle);
  const spanX = Math.hypot(radial[0], normal[0]);
  const spanY = Math.hypot(radial[1], normal[1]);
  return Math.max(
    0,
    Math.min(
      DEPENDENCY_VISUAL.radiusPx,
      (SCENE_REACH_PX - Math.abs(origin.x)) / spanX,
      (SCENE_REACH_PX - Math.abs(origin.y)) / spanY,
    ),
  );
}

/**
 * True when a companion stays inside the home square. Passing close to
 * another crewmate is fine: the stage has no collision avoidance (INF-304).
 */
export function satelliteFits(point: { x: number; y: number }): boolean {
  return Math.abs(point.x) <= SCENE_REACH_PX && Math.abs(point.y) <= SCENE_REACH_PX;
}
