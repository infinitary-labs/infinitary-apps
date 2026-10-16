// The crewmate glyph in orbit: the design skill's Crewmate - a 3D wireframe
// tetrahedron, the simplest solid, deliberately one dimension below the 4D
// Firstmate - plus what orbit life adds: it unfolds from a point when it
// arrives and folds back when it leaves, a working crewmate carries a
// little light of its own and a filament tick walking its edges, an idle
// one goes dim and slow. Colors are the wire tokens the caller read.
//
// Working and idle read in motion and posture: working = fast double
// rotation, pulsing nodes, the tick, a halo, sitting ON the ring; idle =
// slow tumble, a slow bob, sitting a touch farther out. Color says the same
// thing, the Firstmate's own way (captain's board call): a working crewmate
// heats from ice cyan to ember (`--wire-hot`) as the rig does on its turn,
// an idle one stays a dim ice cyan.
//
// The solid says how strong a model the crewmate runs on (captain's board
// verdict, 2026-09-23): a richer 3D solid for a stronger slot, every one
// inscribed in the same sphere and every one still simpler than the 4D
// Firstmate - tetrahedron (low), octahedron (medium), icosahedron (high),
// geodesic sphere (premium). A crewmate whose slot is unknown keeps the
// tetrahedron, claiming no more than the app knows; it paints exactly as a
// crewmate did before tiers existed.

import type { Slot } from "@shared/modelSlots";
import { noise1, TAU } from "../face";
import { FLICKER_TUNING, filamentWaver } from "../flicker";
import type { CrewmateFrame, PacketFrame } from "./orbit";

export type Rgb = [number, number, number];
export type CrewColors = { accent: Rgb; hot: Rgb; boost: number; quiet?: Rgb };

type Vec3 = readonly [number, number, number];
type Edge = readonly [number, number];

const S3 = 1 / Math.sqrt(3);
const VERTICES: ReadonlyArray<Vec3> = [
  [S3, S3, S3],
  [S3, -S3, -S3],
  [-S3, S3, -S3],
  [-S3, -S3, S3],
];
const EDGES: ReadonlyArray<Edge> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];
/**
 * A crewmate's wireframe. Denser solids draw finer so the ring stays calm:
 * `ink` scales edge alpha, line width and node radius. `nodes` is how many
 * of the leading vertices carry a node (all when absent).
 */
export type Solid = {
  v: ReadonlyArray<Vec3>;
  e: ReadonlyArray<Edge>;
  ink: readonly [alpha: number, line: number, node: number];
  nodes?: number;
};

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const onSphere = ([x, y, z]: Vec3): Vec3 => {
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
};
/** A convex solid's edges: every pair of vertices at the shortest distance. */
function edgesOf(v: ReadonlyArray<Vec3>): Edge[] {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++) min = Math.min(min, dist(v[i] as Vec3, v[j] as Vec3));
  const out: Edge[] = [];
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++)
      if (dist(v[i] as Vec3, v[j] as Vec3) < min * 1.01) out.push([i, j]);
  return out;
}
const OCTA_V: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const PHI = (1 + Math.sqrt(5)) / 2;
/** The icosahedron: the cyclic permutations of (0, ±1, ±φ), on the unit sphere. */
const ICOSA_V: Vec3[] = [-1, 1].flatMap((a) =>
  [-1, 1].flatMap((b) =>
    (
      [
        [0, a, b * PHI],
        [a, b * PHI, 0],
        [b * PHI, 0, a],
      ] as const
    ).map(onSphere),
  ),
);
const ICOSA_E = edgesOf(ICOSA_V);

/**
 * The geodesic sphere: the icosahedron with every face split into four and
 * the new corners pushed out to the sphere. Its first 12 vertices are the
 * icosahedron's own, and only those carry a node - a node on each of 42
 * corners at orbit size is noise, not structure.
 */
function geodesic(): Solid {
  const v: Vec3[] = [...ICOSA_V];
  const midpoints = new Map<string, number>();
  const mid = (p: number, q: number): number => {
    const key = `${Math.min(p, q)}:${Math.max(p, q)}`;
    const known = midpoints.get(key);
    if (known !== undefined) return known;
    const a = v[p] as Vec3;
    const b = v[q] as Vec3;
    v.push(onSphere([a[0] + b[0], a[1] + b[1], a[2] + b[2]]));
    midpoints.set(key, v.length - 1);
    return v.length - 1;
  };
  const adjacent = new Set(ICOSA_E.map(([p, q]) => `${p}:${q}`));
  const touches = (p: number, q: number) => adjacent.has(`${Math.min(p, q)}:${Math.max(p, q)}`);
  const edges = new Map<string, Edge>();
  const add = (p: number, q: number) => edges.set(`${Math.min(p, q)}:${Math.max(p, q)}`, [p, q]);
  for (let a = 0; a < 12; a++)
    for (let b = a + 1; b < 12; b++)
      for (let c = b + 1; c < 12; c++) {
        if (!touches(a, b) || !touches(b, c) || !touches(a, c)) continue;
        const ab = mid(a, b);
        const bc = mid(b, c);
        const ca = mid(c, a);
        for (const [p, q] of [
          [a, ab],
          [ab, b],
          [b, bc],
          [bc, c],
          [c, ca],
          [ca, a],
          [ab, bc],
          [bc, ca],
          [ca, ab],
        ] as const)
          add(p, q);
      }
  // The finest ink on the ring; its twelve nodes at four-fifths of the
  // icosahedron's own (0.66), so the corners still read through the mesh.
  return { v, e: [...edges.values()], ink: [0.62, 0.62, 0.66 * 0.8], nodes: 12 };
}

const TETRAHEDRON: Solid = { v: VERTICES, e: EDGES, ink: [1, 1, 1] };
/** Each slot's solid, all inscribed in the unit sphere. */
export const TIER_SOLIDS: Readonly<Record<Slot, Solid>> = {
  low: TETRAHEDRON,
  medium: { v: OCTA_V, e: edgesOf(OCTA_V), ink: [0.92, 0.95, 0.9] },
  high: { v: ICOSA_V, e: ICOSA_E, ink: [0.8, 0.82, 0.66] },
  premium: geodesic(),
};

/** The solid a crewmate is drawn as: its slot's, or the tetrahedron when the slot is unknown. */
export function solidFor(tier: Slot | undefined): Solid {
  return tier ? TIER_SOLIDS[tier] : TETRAHEDRON;
}

const WHITE_HOT: Rgb = [255, 244, 224];
/** The filament tick's cycle: one edge lights per period, for the first 30% of it. */
const TICK_PERIOD_MS = 900;
const TICK_ON = 0.3;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba(c: Rgb, alpha: number): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, alpha))})`;
}

/**
 * A crewmate's wire color and strength at a working blend (0 idle .. 1
 * working): the rig's heat ramp, ice cyan to ember, and an idle crewmate
 * receding by strength, never by a second hue (components/mate/Crewmate).
 */
export function crewmateLight(colors: CrewColors, work: number): { color: Rgb; strength: number } {
  const w = Math.max(0, Math.min(1, work));
  return { color: mix(colors.accent, colors.hot, w), strength: 0.55 + 0.45 * w };
}

/** The light a spark or a packet carries: the Firstmate's accent lifted toward white. */
function sparkColor(colors: CrewColors): Rgb {
  return mix(colors.accent, WHITE_HOT, 0.4);
}

/**
 * The black hole's rush (./rush.ts): the arc a racing crewmate just swept,
 * in its own light lifted toward white, thinning and fading away from it.
 */
function drawStreak(
  ctx: CanvasRenderingContext2D,
  streak: ReadonlyArray<{ x: number; y: number }>,
  f: CrewmateFrame,
  cx: number,
  cy: number,
  colors: CrewColors,
): void {
  const color = mix(crewmateLight(colors, f.work).color, WHITE_HOT, 0.25);
  const segments = streak.length - 1;
  ctx.lineCap = "round";
  for (let i = 0; i < segments; i++) {
    const P = streak[i];
    const Q = streak[i + 1];
    if (!P || !Q) continue;
    const fade = 1 - i / segments;
    ctx.strokeStyle = rgba(color, 0.42 * fade * fade * f.alpha * f.unfold * colors.boost);
    ctx.lineWidth = Math.max(0.6, f.size * 0.2 * fade);
    ctx.beginPath();
    ctx.moveTo(cx + P.x, cy + P.y);
    ctx.lineTo(cx + Q.x, cy + Q.y);
    ctx.stroke();
  }
}

/**
 * Paint one crewmate at its frame position, relative to (cx, cy) - the
 * Firstmate's center on this canvas.
 */
export function drawCrewmate(
  ctx: CanvasRenderingContext2D,
  f: CrewmateFrame,
  cx: number,
  cy: number,
  colors: CrewColors,
  now: number,
): void {
  const jitter = f.nudge > 0.001 ? f.nudge * 3 : 0;
  const px = cx + f.x + (jitter ? noise1((now / 1000) * 14 + f.seed) * jitter : 0);
  const py = cy + f.y + (jitter ? noise1((now / 1000) * 13 + f.seed * 1.7) * jitter : 0);
  const s = f.size;
  const R = s * 0.4;
  const bright = sparkColor(colors);

  if (f.streak && f.unfold > 0.01) drawStreak(ctx, f.streak, f, cx, cy, colors);

  // The travelling spark and its ghosts (spawn) or the fading ember (home).
  if (f.spark > 0.01) {
    for (let g = 0; g < f.trail.length; g++) {
      const ghost = f.trail[g];
      if (!ghost) continue;
      ctx.fillStyle = rgba(bright, (0.55 - g * 0.15) * f.spark * f.alpha);
      ctx.beginPath();
      ctx.arc(cx + ghost.x, cy + ghost.y, (2.2 - g * 0.4) * (s / 30), 0, TAU);
      ctx.fill();
    }
    const sr = 2.8 * f.spark * (s / 30) + 0.6;
    const halo = ctx.createRadialGradient(px, py, 0, px, py, sr * 4);
    halo.addColorStop(0, rgba(colors.accent, 0.35 * f.spark * f.alpha));
    halo.addColorStop(1, rgba(colors.accent, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(px, py, sr * 4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(bright, 0.95 * f.spark * f.alpha);
    ctx.beginPath();
    ctx.arc(px, py, sr, 0, TAU);
    ctx.fill();
  }
  if (f.unfold <= 0.01) return;

  const work = f.work;
  const flick = f.flicker;
  const light = crewmateLight(colors, work);
  // A working crewmate carries a little light of its own, in its own heat;
  // a completed request's flicker is a filament on the wires, so only a
  // whisper of it spills here (../flicker `glowSpill`).
  const spill = flick * FLICKER_TUNING.glowSpill;
  const haloA = (0.14 * work + 0.5 * spill) * f.alpha * f.unfold;
  const haloR = s * (0.95 + 0.2 * spill);
  if (haloA > 0.005) {
    const g = ctx.createRadialGradient(px, py, 0, px, py, haloR);
    g.addColorStop(0, rgba(light.color, haloA));
    g.addColorStop(1, rgba(light.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, haloR, 0, TAU);
    ctx.fill();
  }

  const col = mix(light.color, WHITE_HOT, Math.min(1, f.flash * 0.5 + spill * 0.4));
  // Double rotation; the spin rate already carries the
  // working/idle difference (./orbit.ts).
  const ca = Math.cos(f.spin);
  const sa = Math.sin(f.spin);
  const cb = Math.cos(f.spin * 0.6);
  const sb = Math.sin(f.spin * 0.6);
  const u = f.unfold;
  const solid = solidFor(f.tier);
  const [inkAlpha, inkLine, inkNode] = solid.ink;
  const pts = solid.v.map(([x, y, z]) => {
    const x1 = x * ca - z * sa;
    const z1 = x * sa + z * ca;
    const y1 = y * cb - z1 * sb;
    const z2 = y * sb + z1 * cb;
    const k = 3 / (3 - z2);
    // Unfolding: every vertex grows out from the centroid.
    return [px + x1 * k * R * u, py + y1 * k * R * u, k] as const;
  });
  const base = light.strength * f.alpha * colors.boost;
  const lw = Math.max(1, Math.min(1.6, 1.4 * (s / 30))) * inkLine;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.strokeStyle = rgba(col, 1);
  const seedOff = Math.floor(f.seed * 8);
  for (let ei = 0; ei < solid.e.length; ei++) {
    const [p, q] = solid.e[ei] as Edge;
    const P = pts[p];
    const Q = pts[q];
    if (!P || !Q) continue;
    let alpha =
      Math.max(0.35, Math.min(0.9, 0.4 + ((P[2] + Q[2]) / 2 - 0.85) * 0.9)) * base * inkAlpha;
    if (flick > 0) {
      // The flicker is the filament: each edge wavers on its own phase, and
      // only the edge that's actually hot runs white - never the whole glyph.
      const fw = flick * filamentWaver(ei + seedOff, now);
      ctx.strokeStyle = rgba(mix(col, WHITE_HOT, Math.min(1, fw * 0.7)), 1);
      alpha *= 1 + 0.9 * fw;
    }
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.beginPath();
    ctx.moveTo(P[0], P[1]);
    ctx.lineTo(Q[0], Q[1]);
    ctx.stroke();
  }
  // The filament tick: one edge at a time lights white-hot, walking the
  // solid - the working crewmate's "hands busy" cue, the rig's own filament.
  if (work > 0.05 && u > 0.9) {
    const cycle = now / TICK_PERIOD_MS + f.seed;
    const ph = cycle - Math.floor(cycle);
    if (ph < TICK_ON) {
      const k = Math.sin((ph / TICK_ON) * Math.PI) * work * f.alpha;
      const edge = solid.e[Math.floor(cycle) % solid.e.length];
      const P = edge ? pts[edge[0]] : undefined;
      const Q = edge ? pts[edge[1]] : undefined;
      if (P && Q) {
        ctx.globalAlpha = k;
        ctx.strokeStyle = rgba(mix(light.color, WHITE_HOT, 0.75), 1);
        ctx.lineWidth = lw * 0.6;
        ctx.beginPath();
        ctx.moveTo(P[0], P[1]);
        ctx.lineTo(Q[0], Q[1]);
        ctx.stroke();
        ctx.lineWidth = lw;
      }
    }
  }
  ctx.fillStyle = rgba(col, 1);
  const nodeCount = solid.nodes ?? pts.length;
  for (let i = 0; i < nodeCount; i++) {
    const P = pts[i];
    if (!P) continue;
    // Nodes pulse in sequence while working, as the Firstmate's do.
    let pulseK = 1 + 0.5 * work * Math.max(0, Math.sin(now / 300 + i * 1.3 + f.seed));
    let alpha = Math.max(0.5, Math.min(1, 0.5 + (P[2] - 0.85) * 0.8)) * base * inkAlpha;
    if (flick > 0) {
      // Inside a flicker each node wavers white-hot on its own phase too.
      const nw = flick * filamentWaver(i + seedOff + 20, now);
      ctx.fillStyle = rgba(mix(col, WHITE_HOT, Math.min(1, nw * 0.6)), 1);
      pulseK += 0.15 * flick;
      alpha *= 1 + 0.45 * nw;
    }
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.beginPath();
    ctx.arc(P[0], P[1], 1.2 * (s / 28) * pulseK * (0.4 + 0.6 * u) * inkNode, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** A tether from a waiting crewmate to the one it waits on. The arrowhead sits at the blocker. */
export function drawDependencyLink(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  cx: number,
  cy: number,
  colors: CrewColors,
  lit: boolean,
): void {
  const ax = cx + from.x;
  const ay = cy + from.y;
  const bx = cx + to.x;
  const by = cy + to.y;
  let dx = bx - ax;
  let dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length < 42) return;
  dx /= length;
  dy /= length;
  const startX = ax + dx * 18;
  const startY = ay + dy * 18;
  const endX = bx - dx * 21;
  const endY = by - dy * 21;
  const color = lit ? colors.accent : (colors.quiet ?? colors.accent);
  ctx.save();
  ctx.strokeStyle = rgba(color, lit ? 0.7 : 0.28);
  ctx.lineWidth = lit ? 1.4 : 1;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(endX - dx * 5 - dy * 3, endY - dy * 5 + dx * 3);
  ctx.lineTo(endX, endY);
  ctx.lineTo(endX - dx * 5 + dy * 3, endY - dy * 5 - dx * 3);
  ctx.stroke();
  ctx.restore();
}

/** A packet in flight: one bright dot with a faint halo. */
export function drawPacket(
  ctx: CanvasRenderingContext2D,
  p: PacketFrame,
  cx: number,
  cy: number,
  colors: CrewColors,
): void {
  const x = cx + p.x;
  const y = cy + p.y;
  const halo = ctx.createRadialGradient(x, y, 0, x, y, 9);
  halo.addColorStop(0, rgba(colors.accent, 0.3 * p.alpha));
  halo.addColorStop(1, rgba(colors.accent, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(sparkColor(colors), 0.95 * p.alpha);
  ctx.beginPath();
  ctx.arc(x, y, 2.4, 0, TAU);
  ctx.fill();
}
