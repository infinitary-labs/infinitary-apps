// Exact FI3-340 captain selection. Capacities govern placement, never routing.
// Positive travel follows the original ring (decreasing angle on screen).
export const CROWDED_PLANES = [
  { radius: 164, capacity: 8, inclination: 42, node: -0.42, speedDegPerSec: 8, phase: 0 },
  { radius: 210, capacity: 12, inclination: 65, node: 0.38, speedDegPerSec: -20, phase: 0.53 },
  { radius: 256, capacity: 20, inclination: 16, node: -0.7, speedDegPerSec: -4, phase: 1.06 },
] as const;

export function planePhase(plane: number, now: number): number {
  const p = CROWDED_PLANES[plane];
  if (!p) throw new Error("Unknown orbital plane");
  return -(now / 1000) * (Math.PI / 180) * p.speedDegPerSec;
}

/** Orthographic projection of a true 3D circle, z positive toward the camera. */
export function projectPlane(plane: number, angle: number, radius?: number) {
  const p = CROWDED_PLANES[plane];
  if (!p) throw new Error("Unknown orbital plane");
  const r = radius ?? p.radius;
  const inclination = (p.inclination * Math.PI) / 180;
  const u = r * Math.cos(angle);
  const v = r * Math.sin(angle) * Math.cos(inclination);
  return {
    x: u * Math.cos(p.node) - v * Math.sin(p.node),
    y: u * Math.sin(p.node) + v * Math.cos(p.node),
    z: r * Math.sin(angle) * Math.sin(inclination),
  };
}
