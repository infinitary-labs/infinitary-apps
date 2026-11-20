// The captain's growing ring (INF-1179's accepted orbit_layout). One orbit
// widens a notch with every arrival up to its cap; the 25th crewmate opens a
// second orbit inside it, on another tilt and spinning the other way, which
// grows to its own cap while the first holds at its. No third orbit opens:
// past 48 crew each arrival joins whichever orbit has fewer crew, and both
// pack tighter at their caps. Seats govern placement, never routing.
// Positive travel follows the original ring (decreasing angle on screen).
export const GROWING_RING = {
  /** A lone crewmate's orbit, px. */
  startRadiusPx: 150,
  /** The first orbit's cap, px; each orbit inside caps one step less. */
  capRadiusPx: 256,
  orbitStepPx: 46,
  /** Crew on an orbit before it stops growing and the next one opens. */
  seatsPerOrbit: 24,
  /** Today's inner plane: tilt 42°, turned −0.42 rad. */
  firstTiltDeg: 42,
  tiltStepDeg: 23,
  firstNode: -0.42,
  nodeStepDeg: 46,
  /** The first orbit's travel; each orbit inside spins against the one outside it, faster. */
  speedDegPerSec: 8,
  innerFasterShare: 0.75,
  phaseStep: 0.53,
} as const;

const DEG = Math.PI / 180;

/** Orbit `k` by its place in the stack, the first (outer) one at 0. */
function orbit(k: number) {
  return {
    /** The radius the orbit holds once its seats are full, px. */
    radius: GROWING_RING.capRadiusPx - k * GROWING_RING.orbitStepPx,
    capacity: GROWING_RING.seatsPerOrbit,
    inclination:
      8 + ((((GROWING_RING.firstTiltDeg - 8 + k * GROWING_RING.tiltStepDeg) % 74) + 74) % 74),
    node: GROWING_RING.firstNode + k * GROWING_RING.nodeStepDeg * DEG,
    speedDegPerSec:
      GROWING_RING.speedDegPerSec *
      (k % 2 === 1 ? -1 : 1) *
      (1 + GROWING_RING.innerFasterShare * k),
    phase: k * GROWING_RING.phaseStep,
  };
}

/** Two orbits at most (captain, INF-1179: "let's only allow 2 orbits"). */
export const CROWDED_PLANES = [orbit(0), orbit(1)] as const;

/**
 * Orbit `plane`'s radius with `counts` crew on each orbit: the innermost
 * open orbit grows a notch with every arrival up to its cap, and every
 * orbit outside it holds at its cap.
 */
export function planeRadius(plane: number, counts: readonly number[]): number {
  const p = CROWDED_PLANES[plane];
  if (!p) throw new Error("Unknown orbital plane");
  let innermost = 0;
  counts.forEach((n, i) => {
    if (n > 0) innermost = i;
  });
  if (plane < innermost) return p.radius;
  const n = counts[plane] ?? 0;
  if (n <= 1) return GROWING_RING.startRadiusPx;
  const grown =
    GROWING_RING.startRadiusPx +
    ((p.radius - GROWING_RING.startRadiusPx) * (n - 1)) / (p.capacity - 1);
  return Math.min(p.radius, grown);
}

/**
 * Model names show while one orbit holds the crew and it has this many or
 * fewer (captain, INF-1179: "Show names only while the single orbit has
 * eight crew or fewer, as today"); one orbit seats up to 24.
 */
export const CREW_NAMES_UP_TO = 8;

/** The first orbit's radius for a roster of `count` crew, px: where the formation's edge is. */
export function outerPlaneRadius(count: number): number {
  return planeRadius(0, [Math.min(count, CROWDED_PLANES[0]?.capacity ?? 0)]);
}

export function planePhase(plane: number, now: number): number {
  const p = CROWDED_PLANES[plane];
  if (!p) throw new Error("Unknown orbital plane");
  return -(now / 1000) * DEG * p.speedDegPerSec;
}

/**
 * Orthographic projection of a true 3D circle, z positive toward the camera.
 * `flatten` opens the orbit toward face-on (1 is a flat circle), as the
 * tunnel warp does (../warp.ts).
 */
export function projectPlane(plane: number, angle: number, radius?: number, flatten = 0) {
  const p = CROWDED_PLANES[plane];
  if (!p) throw new Error("Unknown orbital plane");
  const r = radius ?? p.radius;
  const inclination = p.inclination * DEG * (1 - flatten);
  const u = r * Math.cos(angle);
  const v = r * Math.sin(angle) * Math.cos(inclination);
  return {
    x: u * Math.cos(p.node) - v * Math.sin(p.node),
    y: u * Math.sin(p.node) + v * Math.cos(p.node),
    z: r * Math.sin(angle) * Math.sin(inclination),
  };
}
