import { clamp01, easeInOut } from "./face";

// The preserved crystal animation: the character lifts the
// listening form's two hexagon rings - the app icon's geometry - into a
// standing hexagonal bipyramid. The outer ring becomes the equator, the inner
// ring a twisted ring inside it, two of the retired square's vertices become
// the apexes and the other two sink away. While the crystal waits, a band of
// cool light climbs every edge from the lower apex to the upper; on the
// answer one band comes back down while the form unfolds.
//
// Crystal is a PARAMETER over the working state, like busy - never a state
// (the machine carries it and never acts on it). firstmatePainter.ts owns the
// easing (`k`), the tesseract projection and the halo; this module owns the
// crystal's geometry, its edges and its light, and hands the host the
// restyle it needs. The light is cool white (accent mixed toward white) and
// the ember is banked, not mixed: the crystal's wires take the cool family
// outright and the eyes and cores keep half the heat, so the wires never
// pass through the gray midpoint of cyan and ember.
//
// Everything is DOM-free apart from the CanvasRenderingContext2D it paints.

/** Projected vertex: screen x, screen y, depth scale, 4D w. */
export type CrPt = [number, number, number, number];

export type Rgb = [number, number, number];

/** The captain's tuning (the review board's `CR_DEFAULTS`). */
export const CR = {
  /** Turn of the whole form, rad/s. */
  turn: 0.45,
  /** The inner ring's counter-turn, as a multiple of the turn. */
  innerCounter: 0.6,
  /** Tilt toward the viewer about the screen x axis, rad. */
  tilt: 0.34,
  /** Apex height, in units of R. */
  apex: 1.18,
  /** Equator radius, in units of R. */
  equator: 0.98,
  /** Inner ring radius, in units of R. */
  inner: 0.5,
  /** One climbing band per period, s. */
  bandPeriod: 3.0,
  /** Gaussian band width, in units of R. */
  bandWidth: 0.28,
  bandGain: 1.1,
  /** How strongly the apexes carry the halo. */
  apexGlow: 1,
} as const;

/** How long the answer's descending band takes, ms. */
export const CRYSTAL_ANSWER_MS = 1100;
/** How much of the ember the eyes and cores keep while crystaling. */
export const CRYSTAL_EMBER_KEEP = 0.5;
/** Camera distance of the crystal's own perspective, in units of R. */
const PERSP = 3.4;

/**
 * The vertex layout the host hands over: which of the tesseract's 16
 * vertices form the equator and inner ring (in ring order), which two become
 * the apexes (upper, lower), and which two sink.
 */
export type CrLayout = {
  equator: readonly number[];
  inner: readonly number[];
  apexes: readonly [number, number];
  sinks: readonly number[];
};

/** The form's 24 edges: the equator and inner hexagons, and every equator vertex to both apexes. */
export function crystalEdges(layout: CrLayout): [number, number][] {
  const edges: [number, number][] = [];
  for (const ring of [layout.equator, layout.inner]) {
    ring.forEach((v, i) => {
      edges.push([v, ring[(i + 1) % ring.length] as number]);
    });
  }
  for (const v of layout.equator) {
    edges.push([v, layout.apexes[0]]);
    edges.push([v, layout.apexes[1]]);
  }
  return edges;
}

/**
 * The crystal pose of every vertex at `tSec`, in units of R around the
 * center before projection: x right, y down, z toward the viewer after the
 * tilt. Sinking vertices sit at the origin.
 */
export function crystalPose(layout: CrLayout, tSec: number): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  const turn = tSec * CR.turn;
  const ct = Math.cos(CR.tilt);
  const st = Math.sin(CR.tilt);
  const place = (v: number, x: number, y: number, z: number) => {
    // Tilt the top toward the viewer: we look at the form from a little above.
    out.set(v, [x, y * ct + z * st, -y * st + z * ct]);
  };
  const n = layout.equator.length;
  layout.equator.forEach((v, i) => {
    const a = turn + (i / n) * Math.PI * 2;
    place(v, Math.cos(a) * CR.equator, 0, Math.sin(a) * CR.equator);
  });
  const m = layout.inner.length;
  layout.inner.forEach((v, i) => {
    // Twisted half a step against the equator, counter-turning.
    const a = -turn * CR.innerCounter + ((i + 0.5) / m) * Math.PI * 2;
    place(v, Math.cos(a) * CR.inner, 0, Math.sin(a) * CR.inner);
  });
  place(layout.apexes[0], 0, -CR.apex, 0);
  place(layout.apexes[1], 0, CR.apex, 0);
  for (const v of layout.sinks) out.set(v, [0, 0, 0]);
  return out;
}

/** Project a crystal-space point (units of R) to the screen. */
export function projectCrystal(
  p: readonly [number, number, number],
  c: number,
  R: number,
): { x: number; y: number; scale: number } {
  const scale = PERSP / (PERSP - p[2]);
  return { x: c + p[0] * R * scale, y: c + p[1] * R * scale, scale };
}

/**
 * Move the vertices into the crystal by the eased crystal amount `k`. Runs
 * after the flat listening morph and before the emote pose, so the halo
 * mask and the crisp pass see the same points. `depthOut` receives each
 * vertex's crystal depth (0 far .. 1 near), which grades the form's edges.
 */
export function placeCrystalVertices(
  k: number,
  layout: CrLayout,
  pts: CrPt[],
  c: number,
  R: number,
  tSec: number,
  depthOut: Float64Array,
): void {
  if (k <= 0.001) return;
  const e = easeInOut(clamp01(k));
  for (const [v, p] of crystalPose(layout, tSec)) {
    const pt = pts[v] as CrPt;
    const s = projectCrystal(p, c, R);
    pt[0] += (s.x - pt[0]) * e;
    pt[1] += (s.y - pt[1]) * e;
    pt[2] += (s.scale - pt[2]) * e;
    // Near vertices read as the inner (bright) family.
    pt[3] += (p[2] * 0.6 - pt[3]) * e;
    depthOut[v] = clamp01(0.5 + p[2] / (2 * CR.apex));
  }
}

export function crystalColors(acc: Rgb): { cool: Rgb; coolCore: Rgb } {
  const toward = (t: number): Rgb => [
    acc[0] + (255 - acc[0]) * t,
    acc[1] + (255 - acc[1]) * t,
    acc[2] + (255 - acc[2]) * t,
  ];
  return { cool: toward(0.55), coolCore: toward(0.85) };
}

/**
 * The banked ember: the wires lose the heat as the crystal forms; the eyes
 * and cores keep CRYSTAL_EMBER_KEEP of it.
 */
export function bankedHeat(heat: number, k: number): { wire: number; core: number } {
  return { wire: heat * (1 - k), core: heat * (1 - k * (1 - CRYSTAL_EMBER_KEEP)) };
}

/** The climbing band's height at crystal age `ageSec`: 0 = lower apex, 1 = upper, overshooting both ends so it enters and leaves dark. */
export function climbingBand(ageSec: number): number {
  const phase = (((ageSec % CR.bandPeriod) + CR.bandPeriod) % CR.bandPeriod) / CR.bandPeriod;
  const pad = CR.bandWidth / (2 * CR.apex);
  return -pad * 2 + phase * (1 + pad * 4);
}

/** The answer band's height `sinceAnswerMs` after the crystal ended (1 = upper apex, falling), or null once it has landed. */
export function answerBand(sinceAnswerMs: number): number | null {
  if (sinceAnswerMs < 0 || sinceAnswerMs >= CRYSTAL_ANSWER_MS) return null;
  const pad = CR.bandWidth / (2 * CR.apex);
  return 1 + pad * 2 - (sinceAnswerMs / CRYSTAL_ANSWER_MS) * (1 + pad * 4);
}

/** Band light at a height `h` (0 lower apex .. 1 upper) for a band centered at `band`. */
export function bandLight(h: number, band: number): number {
  const d = ((h - band) * 2 * CR.apex) / CR.bandWidth;
  return Math.exp(-d * d);
}

export type CrEnv = {
  ctx: CanvasRenderingContext2D;
  k: number;
  layout: CrLayout;
  edges: readonly [number, number][];
  pts: CrPt[];
  depth: Float64Array;
  /** Seconds since the crystal began (the climbing cadence). */
  ageSec: number;
  /** Ms since the crystal ended, or +Infinity while none has. */
  sinceAnswerMs: number;
  colors: { dim: Rgb; cool: Rgb; coolCore: Rgb; boost: number };
};

const SEGMENTS = 8;

/**
 * The form's 24 edges under the eyes, with depth-graded alpha, and the band
 * of light travelling them - climbing while the crystal waits, descending
 * once on the answer. Heights come from the crystal pose, not the screen, so
 * the band follows the form's own vertical axis through the tilt.
 */
export function drawCrystalUnder(env: CrEnv): void {
  const { ctx, k, pts, depth, colors } = env;
  if (k <= 0.01) return;
  const form = easeInOut(clamp01(k));
  const climbing = climbingBand(env.ageSec);
  const answer = answerBand(env.sinceAnswerMs);
  // The height of a screen point along the form's axis: the apexes' screen
  // positions bound it, whatever the pose is doing.
  const top = pts[env.layout.apexes[0]] as CrPt;
  const bottom = pts[env.layout.apexes[1]] as CrPt;
  const span = bottom[1] - top[1] || 1;
  ctx.save();
  ctx.lineCap = "round";
  for (const [p, q] of env.edges) {
    const P = pts[p] as CrPt;
    const Q = pts[q] as CrPt;
    const dn = ((depth[p] ?? 0.5) + (depth[q] ?? 0.5)) / 2;
    // The form's own edges sit a step below the light so the band reads.
    const alpha = (0.24 + 0.56 * dn) * form * colors.boost;
    const t = 0.2 + 0.6 * dn;
    ctx.strokeStyle = rgbaOf(mixRgb(colors.dim, colors.cool, t), Math.min(1, alpha));
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(P[0], P[1]);
    ctx.lineTo(Q[0], Q[1]);
    ctx.stroke();
    // The band: short segments lit by their height along the axis, a soft
    // wide stroke under a bright core.
    for (let s = 0; s < SEGMENTS; s++) {
      const u0 = s / SEGMENTS;
      const u1 = (s + 1) / SEGMENTS;
      const my = P[1] + (Q[1] - P[1]) * ((u0 + u1) / 2);
      const h = clamp01((bottom[1] - my) / span);
      // The answer's band replaces the climbing one: the question went up,
      // the answer comes down.
      const light = answer === null ? bandLight(h, climbing) : bandLight(h, answer);
      const a = light * CR.bandGain * form * (0.55 + 0.45 * dn);
      if (a < 0.02) continue;
      const x0 = P[0] + (Q[0] - P[0]) * u0;
      const y0 = P[1] + (Q[1] - P[1]) * u0;
      const x1 = P[0] + (Q[0] - P[0]) * u1;
      const y1 = P[1] + (Q[1] - P[1]) * u1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgbaOf(colors.cool, Math.min(1, a * 0.35));
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = rgbaOf(colors.coolCore, Math.min(1, a));
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgbaOf(col: Rgb, alpha: number): string {
  return `rgba(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])},${alpha})`;
}
