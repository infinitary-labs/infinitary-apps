import type { PanelKnowledgeConnection, PanelKnowledgeGraphConcept } from "@infinitary/contracts";

/**
 * The knowledge graph's geometry (the design skill's
 * `components/knowledge/KnowledgeBrowser`, "The graph" and "The camera"):
 * where each concept sits in three dimensions, how the camera that orbits
 * them projects each one onto the drawing, and where a label goes so it
 * covers no other. Pure arithmetic, so the browser draws what these say
 * and a test can hold every sign of the camera.
 *
 * The layout is computed once from what the read gave - deterministic, from
 * the concepts' ids and their connections - and stays put while the captain
 * explores: no simulation runs, nothing drifts, and nothing turns by itself.
 */

/** A point in the graph's space: the layout fits it inside a sphere of `LAYOUT_RADIUS`. */
export type Point3 = { x: number; y: number; z: number };

export type Camera = { yaw: number; pitch: number; zoom: number };

/** The neutral overview: where a new browser starts and where Reset view and Home return. */
export const HOME_CAMERA: Camera = { yaw: 0.18, pitch: -0.12, zoom: 1 };

/** How far a pointer's pixel turns or tilts the camera, in radians. */
export const DRAG_RADIANS_PER_PX = 0.009;
/** How far one press of Orbit left or Orbit right turns it. */
export const ORBIT_BUTTON_STEP = 0.22;
/** How far one Shift with an arrow turns or tilts it. */
export const ORBIT_KEY_STEP = 0.16;
/** The tilt stops short of looking straight down or up. */
export const PITCH_LIMIT = 1.15;
/** Zoom runs from 60% to 145% in steps of 10%. */
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 1.45;
export const ZOOM_STEP = 0.1;
/** A press that moves farther than this is an orbit, never a selection. */
export const DRAG_THRESHOLD_PX = 5;

/** The layout's radius, in the graph's units. */
export const LAYOUT_RADIUS = 240;
/** The camera's distance from the center, in the graph's units: the perspective. */
const DEPTH = 650;

const clampPitch = (pitch: number) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
const clampZoom = (zoom: number) =>
  Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)) * 100) / 100;

/**
 * The camera after a drag of `dx`, `dy` pixels from where it was when the
 * press began. It orbits the fixed center as a game camera orbits its
 * character (the captain: "follow how popular video games do it - like WoW
 * camera control"): a drag to the right turns the camera to the right, the
 * opposite of the scene rotation it replaced, so the far side of the graph
 * sweeps left and the near side right; a drag down tilts it down. Either
 * mouse button orbits the same way.
 */
export function orbitByDrag(from: Camera, dx: number, dy: number): Camera {
  return {
    ...from,
    yaw: from.yaw - dx * DRAG_RADIANS_PER_PX,
    pitch: clampPitch(from.pitch + dy * DRAG_RADIANS_PER_PX),
  };
}

/** Orbit left or right by one step, the way a drag the same way does. */
export function orbitStep(
  from: Camera,
  toward: "left" | "right",
  step = ORBIT_BUTTON_STEP,
): Camera {
  return { ...from, yaw: from.yaw + (toward === "right" ? -step : step) };
}

/** Tilt up or down by one step, the way a drag the same way does. */
export function tiltStep(from: Camera, toward: "up" | "down", step = ORBIT_KEY_STEP): Camera {
  return { ...from, pitch: clampPitch(from.pitch + (toward === "down" ? step : -step)) };
}

export function zoomStep(from: Camera, toward: "in" | "out"): Camera {
  return { ...from, zoom: clampZoom(from.zoom + (toward === "in" ? ZOOM_STEP : -ZOOM_STEP)) };
}

/** A concept as drawn: where on the drawing, how deep, and how big its dot is. */
export type Projected = { id: string; x: number; y: number; depth: number; radius: number };

/**
 * Where a point lands on a drawing `width` by `height` under `camera`:
 * turned by its yaw around the vertical axis, tilted by its pitch, then
 * seen in perspective, so a nearer point is farther from the center and
 * larger. `depth` grows away from the camera.
 */
export function project(
  point: Point3,
  camera: Camera,
  width: number,
  height: number,
): Omit<Projected, "id"> {
  const scale = Math.min(width / 670, height / 520) * camera.zoom;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const x1 = point.x * cosYaw + point.z * sinYaw;
  const z1 = -point.x * sinYaw + point.z * cosYaw;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const y1 = point.y * cosPitch - z1 * sinPitch;
  const depth = point.y * sinPitch + z1 * cosPitch;
  const perspective = DEPTH / (DEPTH + depth);
  return {
    x: width / 2 + x1 * scale * perspective,
    y: height / 2 + y1 * scale * perspective,
    depth,
    radius: Math.max(3, 5.4 * perspective),
  };
}

/** How strong a dot is: nearer is stronger, from 80% down to 40%. */
export function depthOpacity(depth: number): number {
  return Math.max(0.4, Math.min(0.8, 0.8 - depth / 700));
}

/** The layout's spring length, as a share of its radius before the count divides it. */
const SPRING = 1.6;
/**
 * How hard the center pulls each concept: strong enough that separate
 * groups share one view and connected concepts sit apart enough to label.
 */
const GRAVITY = 0.5;

/** A stable number from an id, for the layout's starting places. */
function hashOf(text: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/**
 * Where each concept sits: a force layout in three dimensions run to rest
 * once - connected concepts pull together, every pair pushes apart, and a
 * light pull holds them around the center - from starting places that
 * depend only on each concept's id, so the same collection always lays out
 * the same way. Scaled to fit `LAYOUT_RADIUS`.
 */
export function layoutGraph(
  concepts: readonly Pick<PanelKnowledgeGraphConcept, "id">[],
  connections: readonly Pick<PanelKnowledgeConnection, "from" | "to">[],
  iterations = 240,
): Map<string, Point3> {
  const ids = concepts.map((concept) => concept.id).sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const places = new Map<string, Point3>();
  if (n === 0) return places;
  if (n === 1) {
    places.set(ids[0] as string, { x: 0, y: 0, z: 0 });
    return places;
  }
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  ids.forEach((id, i) => {
    // A point on the sphere from two hashes of the id.
    const u = hashOf(id, 1) * 2 - 1;
    const theta = hashOf(id, 2) * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    xs[i] = LAYOUT_RADIUS * r * Math.cos(theta);
    ys[i] = LAYOUT_RADIUS * u;
    zs[i] = LAYOUT_RADIUS * r * Math.sin(theta);
  });
  // In one order whatever order the read gave them, so the sums - and the places - are the same.
  const links = connections
    .flatMap((connection) => {
      const a = index.get(connection.from);
      const b = index.get(connection.to);
      return a === undefined || b === undefined || a === b
        ? []
        : [[Math.min(a, b), Math.max(a, b)] as const];
    })
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const k = (LAYOUT_RADIUS * SPRING) / Math.cbrt(n);
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fz = new Float64Array(n);
  for (let step = 0; step < iterations; step++) {
    const temperature = (LAYOUT_RADIUS / 6) * (1 - step / iterations) + 0.5;
    fx.fill(0);
    fy.fill(0);
    fz.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = (xs[i] as number) - (xs[j] as number);
        const dy = (ys[i] as number) - (ys[j] as number);
        const dz = (zs[i] as number) - (zs[j] as number);
        const d2 = Math.max(dx * dx + dy * dy + dz * dz, 0.01);
        const push = (k * k) / d2;
        fx[i] = (fx[i] as number) + dx * push;
        fy[i] = (fy[i] as number) + dy * push;
        fz[i] = (fz[i] as number) + dz * push;
        fx[j] = (fx[j] as number) - dx * push;
        fy[j] = (fy[j] as number) - dy * push;
        fz[j] = (fz[j] as number) - dz * push;
      }
    }
    for (const [a, b] of links) {
      const dx = (xs[a] as number) - (xs[b] as number);
      const dy = (ys[a] as number) - (ys[b] as number);
      const dz = (zs[a] as number) - (zs[b] as number);
      const d = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.01);
      const pull = d / k;
      fx[a] = (fx[a] as number) - dx * pull;
      fy[a] = (fy[a] as number) - dy * pull;
      fz[a] = (fz[a] as number) - dz * pull;
      fx[b] = (fx[b] as number) + dx * pull;
      fy[b] = (fy[b] as number) + dy * pull;
      fz[b] = (fz[b] as number) + dz * pull;
    }
    for (let i = 0; i < n; i++) {
      // A light pull to the center keeps a concept with no connection near.
      const gx = (fx[i] as number) - (xs[i] as number) * GRAVITY;
      const gy = (fy[i] as number) - (ys[i] as number) * GRAVITY;
      const gz = (fz[i] as number) - (zs[i] as number) * GRAVITY;
      const length = Math.max(Math.sqrt(gx * gx + gy * gy + gz * gz), 0.01);
      const move = Math.min(length, temperature) / length;
      xs[i] = (xs[i] as number) + gx * move;
      ys[i] = (ys[i] as number) + gy * move;
      zs[i] = (zs[i] as number) + gz * move;
    }
  }
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i] as number;
    cy += ys[i] as number;
    cz += zs[i] as number;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let reach = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - cx;
    const dy = (ys[i] as number) - cy;
    const dz = (zs[i] as number) - cz;
    reach = Math.max(reach, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const fit = reach > 0 ? LAYOUT_RADIUS / reach : 1;
  ids.forEach((id, i) => {
    places.set(id, {
      x: ((xs[i] as number) - cx) * fit,
      y: ((ys[i] as number) - cy) * fit,
      z: ((zs[i] as number) - cz) * fit,
    });
  });
  return places;
}

export type Box = { x: number; y: number; width: number; height: number };

const GAP = 3;

function overlaps(a: Box, b: Box): boolean {
  return !(
    a.x + a.width + GAP < b.x ||
    b.x + b.width + GAP < a.x ||
    a.y + a.height + GAP < b.y ||
    b.y + b.height + GAP < a.y
  );
}

/** A label's tag, about as wide as its words at the label's size, with its padding. */
export function labelWidth(text: string, max: number): number {
  return Math.min(max, text.length * 6.8 + 14);
}

export const LABEL_HEIGHT = 22;

/**
 * Places a concept's label: above its dot, below it, beside it, or farther
 * out, at the first place that covers no label or dot already placed,
 * inside the drawing. Null when no place is free - the label is not drawn,
 * and the list under the graph still names the concept.
 */
export function placeNodeLabel(
  at: { x: number; y: number },
  text: string,
  taken: readonly Box[],
  width: number,
  height: number,
): Box | null {
  const w = labelWidth(text, width - 16);
  const centered = at.x - w / 2;
  const middle = at.y - LABEL_HEIGHT / 2;
  const candidates: [number, number][] = [
    [centered, at.y - 34],
    [centered, at.y + 12],
    [at.x + 12, middle],
    [at.x - 12 - w, middle],
    [centered, at.y - 58],
    [centered, at.y + 36],
    [at.x + 12, middle - 26],
    [at.x - 12 - w, middle + 26],
  ];
  for (const [left, top] of candidates) {
    const x = Math.min(width - w - 4, Math.max(4, left));
    const y = Math.min(height - LABEL_HEIGHT - 4, Math.max(4, top));
    const box = { x, y, width: w, height: LABEL_HEIGHT };
    if (taken.every((other) => !overlaps(box, other))) return box;
  }
  return null;
}

/**
 * Places a connection's predicate along its line: at the middle, then a
 * third of the way from either end, each on the line or to one side,
 * whichever covers no label already placed. Null when none is free.
 */
export function placeEdgeLabel(
  from: { x: number; y: number },
  to: { x: number; y: number },
  text: string,
  taken: readonly Box[],
  width: number,
  height: number,
): Box | null {
  const w = labelWidth(text, width - 16);
  for (const t of [0.5, 0.3, 0.7]) {
    for (const dy of [-12, -40, 16, 40, -64, 64]) {
      const x = Math.max(4, Math.min(width - w - 4, from.x + (to.x - from.x) * t - w / 2));
      const y = Math.max(
        4,
        Math.min(height - LABEL_HEIGHT - 4, from.y + (to.y - from.y) * t + dy - LABEL_HEIGHT / 2),
      );
      const box = { x, y, width: w, height: LABEL_HEIGHT };
      if (taken.every((other) => !overlaps(box, other))) return box;
    }
  }
  return null;
}

/** Where a line toward `to` stops, short of its dot, so an arrowhead shows. */
export function lineEnd(
  from: { x: number; y: number },
  to: { x: number; y: number; radius: number },
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const stop = Math.min(length / 3, to.radius + 6);
  return { x: to.x - (dx / length) * stop, y: to.y - (dy / length) * stop };
}
