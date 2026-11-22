import { band, clamp01, easeInOut, easeOut, TAU } from "./face";

// The pretend black hole: the captain's pick from the three-treatment review
// (firstmate/data/fm3000-blackhole-emote-proto-s1/report.md, 2026-09-05) - a
// thin inclined accretion disk whose FAR side is gravitationally lensed over
// the top of the shadow, the Luminet 1979 / Gargantua picture. The disk
// ellipse and its lensed image are the two rings; Doppler beaming brightens
// the approaching side; quanta escape the rim as a stylized Hawking cue.
//
// Physics honesty is part of the design: an accretion disk is ONE flat disk,
// and the second ring here is that same disk's far side bent by gravity, not
// a second disk. Hawking radiation from any astrophysical black hole is far
// colder than the microwave background and invisible; the escaping pairs are
// a deliberate cartoon of Hawking's pair-at-the-horizon picture.
//
// The character keeps its identity through the emote: the same 16 vertices
// wind into the disk (firstmatePainter.ts owns the projection and hands the points
// here), the wires follow them as disk streamlines, and the eyes become two
// hot spots caught in the disk, the far one riding up the lensed arc. The
// emote's envelope, gaze and squint are unchanged from the shipped fidget.
//
// Everything is DOM-free apart from the CanvasRenderingContext2D it paints.

/** Projected vertex: screen x, screen y, depth scale, 4D w. */
export type BhPt = [number, number, number, number];

/** How the 16 vertices wind into the disc. */
export type BhLayout = {
  /** Winding rank 0..15 (inner square first, hexagons after). */
  rank: number[];
  /** Vertex ids in winding order. */
  order: number[];
};

export type Rgb = [number, number, number];

/**
 * The envelope's schedule, as fractions of the fidget: the wind-up starts at
 * `windAt` and takes `windFor`, the unwind starts at `unwindAt` and takes
 * `unwindFor`. The crew's rush (./crew/rush.ts) keys off the same moments.
 */
export const BH_SCHEDULE = { windAt: 0.05, windFor: 0.25, unwindAt: 0.8, unwindFor: 0.17 };

/** The wind-up / hold / unwind envelope of the pretend black hole. */
export const bhEnvelope = (et: number): number =>
  band(et, BH_SCHEDULE.windAt, BH_SCHEDULE.windFor, BH_SCHEDULE.unwindAt, BH_SCHEDULE.unwindFor);

/** Shadow radius at full strength, in units of the character radius R. */
const SHADOW_K = 0.5;
/** Inclination flattening (minor/major of the disk ellipse). */
const LENS_Q = 0.3;
/** How high the far side is lifted, in shadow radii. */
const LENS_LIFT = 1.28;
/** How much the far side's x hugs in toward the shadow. */
const LENS_HUG = 0.42;
/** Inner edge of the disk (ISCO-ish), in shadow radii. */
const LENS_INNER = 1.18;
/** Outer edge of the disk, in units of R. */
const LENS_OUTER_R = 1.62;
/** How far an escaping quantum travels, in units of R. */
const QUANTA_REACH_R = 0.72;

/** The shadow's radius this frame, in px. */
export function blackholeShadowRadius(bh: number, R: number): number {
  return R * SHADOW_K * bh;
}

/**
 * Project a point of the inclined disk at polar (rho, phi) to the screen.
 * phi = 0 is the disk's right edge, the far side has sin(phi) > 0. The near
 * side is a plain ellipse; the far side is lifted over the top of the shadow
 * by a lens term that grows with sin(phi) and is continuous through the disk's
 * edges, so a curve crossing from near to far never jumps.
 */
function lensedPoint(
  c: number,
  rs: number,
  rho: number,
  phi: number,
  out: [number, number],
): [number, number] {
  const s = Math.sin(phi);
  const co = Math.cos(phi);
  if (s <= 0) {
    out[0] = c + rho * co;
    out[1] = c - rho * LENS_Q * s;
    return out;
  }
  const flat = rho * LENS_Q * s;
  const lift = LENS_LIFT * rs * s;
  out[0] = c + rho * co * (1 - LENS_HUG * s);
  out[1] = c - Math.sqrt(flat * flat + lift * lift);
  return out;
}

/** Disk coordinates (radius, azimuth) of each vertex's slot this frame. */
const bhRho = new Float64Array(16);
const bhPhi = new Float64Array(16);

/**
 * Wind the 16 vertices into the disk. `pts` arrive at their normal projected
 * positions and leave at the blended emote positions; `progress[i]` reports
 * how far vertex i has wound in (the caller fades its wires by it). The same
 * tangential wind-up as the shipped spiral - inner cell first, hexagons
 * wrapping after, every vertex swirling in so the wind-up reads as wrapping
 * itself up - into slots on the inclined disk: rank runs inner (ISCO) to
 * outer with a trailing spiral offset and mildly differential rotation, and
 * far-side slots ride the lensed arc.
 */
export function placeBlackholeVertices(
  bh: number,
  layout: BhLayout,
  pts: BhPt[],
  c: number,
  R: number,
  tSec: number,
  progress: Float64Array,
): void {
  if (bh <= 0.001) {
    progress.fill(0);
    return;
  }
  const rsFull = R * SHADOW_K;
  const inner = LENS_INNER * rsFull;
  const outer = LENS_OUTER_R * R;
  const spin = tSec * 2.2;
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < 16; i++) {
    const u = (layout.rank[i] ?? 0) / 15; // 0 = innermost slot
    const bi = easeInOut(clamp01(bh * 1.6 - u * 0.6));
    progress[i] = bi;
    if (bi <= 0) continue;
    const p = pts[i] as BhPt;
    // Tangential approach: the start position swirls with progress, so
    // travel paths curve around the center instead of cutting across.
    const sw = bi * 1.6;
    const cs = Math.cos(sw);
    const sn = Math.sin(sw);
    const dx = p[0] - c;
    const dy = p[1] - c;
    const sx = c + dx * cs - dy * sn;
    const sy = c + dx * sn + dy * cs;
    const rho = inner + (outer - inner) * u;
    const phi = spin * (1 + 0.35 * (1 - u)) + u * TAU * 1.2;
    bhRho[i] = rho;
    bhPhi[i] = phi;
    lensedPoint(c, rsFull, rho, phi, tmp);
    p[0] = sx + (tmp[0] - sx) * bi;
    p[1] = sy + (tmp[1] - sy) * bi;
  }
}

/**
 * Where an eye goes during the emote: caught in the disk just outside the
 * ISCO, the near leg passing in front of the shadow, the far leg riding up
 * the lensed arc. Returns the blended position and a depth size factor;
 * outside the emote (bh ~ 0) the base position comes back unchanged.
 */
export function blackholeEye(
  bh: number,
  side: number,
  base: [number, number],
  c: number,
  R: number,
  tSec: number,
): { x: number; y: number; depthMul: number } {
  if (bh <= 0.001) return { x: base[0], y: base[1], depthMul: 1 };
  const rsFull = R * SHADOW_K;
  const rho = rsFull * (LENS_INNER + 0.22);
  const phi = tSec * 1.35 + (side === 1 ? 0 : Math.PI);
  const tmp: [number, number] = [0, 0];
  lensedPoint(c, rsFull, rho, phi, tmp);
  const k = Math.min(1, bh * 1.25);
  const far = Math.sin(phi) > 0;
  return {
    x: base[0] + (tmp[0] - base[0]) * k,
    y: base[1] + (tmp[1] - base[1]) * k,
    depthMul: 1 + (far ? -0.12 : 0.1) * bh,
  };
}

// ---- drawing ----------------------------------------------------------------

export type BhColors = {
  acc: Rgb;
  dim: Rgb;
  hot: Rgb;
  bg: Rgb;
  /** 0..1 ember blend (busy). */
  heat: number;
  /** Alpha multiplier from the theme. */
  boost: number;
};

export type BhEnv = {
  ctx: CanvasRenderingContext2D;
  /** The envelope this frame, > 0. */
  bh: number;
  layout: BhLayout;
  pts: BhPt[];
  progress: Float64Array;
  c: number;
  R: number;
  size: number;
  tSec: number;
  colors: BhColors;
};

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgba = (c: Rgb, a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a))})`;
const WHITE: Rgb = [255, 246, 230];

/** The wire family this frame: ice cyan, ember when the turn is running. */
const wireRgb = (col: BhColors): Rgb => mixRgb(col.acc, col.hot, col.heat);

/** A Doppler stroke gradient: bright on the approaching (left) side, dim opposite. */
function dopplerStroke(env: BhEnv, extent: number, alpha: number, whiten: number): CanvasGradient {
  const { ctx, c, colors } = env;
  const wire = wireRgb(colors);
  const g = ctx.createLinearGradient(c - extent, c, c + extent, c);
  g.addColorStop(0, rgba(mixRgb(wire, WHITE, whiten), alpha));
  g.addColorStop(0.5, rgba(wire, alpha * 0.68));
  g.addColorStop(1, rgba(mixRgb(wire, colors.dim, 0.6), alpha * 0.26));
  return g;
}

/**
 * Painted BEFORE the crisp geometry: the disk's soft halo, then the shadow
 * and its bright rim, so dots and wires passing in front of the shadow really
 * are in front of it.
 */
export function drawBlackholeUnder(env: BhEnv): void {
  const { ctx, bh, c, R, colors } = env;
  const hr = blackholeShadowRadius(bh, R);
  const wire = wireRgb(colors);
  // The disk's diffuse light: a soft ring-shaped halo outside the shadow.
  const outer = LENS_OUTER_R * R;
  const g = ctx.createRadialGradient(c, c, hr * 0.9, c, c, outer);
  g.addColorStop(0, rgba(wire, 0));
  g.addColorStop(0.12, rgba(wire, 0.14 * bh * colors.boost));
  g.addColorStop(0.5, rgba(wire, 0.063 * bh * colors.boost));
  g.addColorStop(1, rgba(wire, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(c, c, outer, outer * (LENS_Q + 0.32), 0, 0, TAU);
  ctx.fill();
  if (hr <= 0.5) return;
  // The shadow: the app background, swallowing whatever sits inside it.
  ctx.fillStyle = rgba(colors.bg, 0.97 * Math.min(1, bh * 1.5));
  ctx.beginPath();
  ctx.arc(c, c, hr, 0, TAU);
  ctx.fill();
  // The photon ring: a thin bright rim just outside the shadow.
  ctx.strokeStyle = rgba(mixRgb(wire, WHITE, 0.55), 0.8 * bh * colors.boost);
  ctx.lineWidth = Math.max(1.2, env.size * 0.006);
  ctx.beginPath();
  ctx.arc(c, c, hr * 1.06, 0, TAU);
  ctx.stroke();
}

/**
 * The winding chain drawn as streamlines of the disk: between consecutive
 * vertices the path is interpolated in disk coordinates (radius, azimuth) and
 * projected, so it follows the disk - and its lensed image - instead of
 * cutting a straight chord across the shadow. While a pair is still winding
 * in, the path blends toward the straight line between the actual points so
 * the wire always meets its dots.
 */
function drawDiskChain(env: BhEnv, hr: number): void {
  const { ctx, pts, progress, layout, colors, c } = env;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const tmp: [number, number] = [0, 0];
  const SEG = 10;
  for (let k = 0; k < 15; k++) {
    const i1 = layout.order[k] as number;
    const i2 = layout.order[k + 1] as number;
    const formed = Math.min(progress[i1] ?? 0, progress[i2] ?? 0);
    if (formed < 0.25) continue;
    const u = k / 15;
    const P = pts[i1] as BhPt;
    const Q = pts[i2] as BhPt;
    const r1 = bhRho[i1] as number;
    const r2 = bhRho[i2] as number;
    const a1 = bhPhi[i1] as number;
    let da = ((bhPhi[i2] as number) - a1) % TAU;
    if (da > Math.PI) da -= TAU;
    if (da < -Math.PI) da += TAU;
    const w = clamp01((formed - 0.25) / 0.75);
    ctx.strokeStyle = rgba(
      mixRgb(mixRgb(colors.acc, WHITE, 0.55 * (1 - u)), colors.hot, colors.heat * 0.5),
      w * (0.85 - u * 0.35) * colors.boost * 0.9,
    );
    ctx.lineWidth = Math.max(1, env.size * 0.005) * (1.4 - u * 0.6);
    ctx.beginPath();
    for (let s = 0; s <= SEG; s++) {
      const f = s / SEG;
      lensedPoint(c, hr, r1 + (r2 - r1) * f, a1 + da * f, tmp);
      const lx = P[0] + (Q[0] - P[0]) * f;
      const ly = P[1] + (Q[1] - P[1]) * f;
      const x = lx + (tmp[0] - lx) * w;
      const y = ly + (tmp[1] - ly) * w;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/**
 * The stylized Hawking cue: pairs appear at the rim, one quantum escapes
 * outward with a short trail and fades, its partner falls in.
 */
function drawHawkingPairs(env: BhEnv, hr: number): void {
  const { ctx, bh, c, R, tSec, colors } = env;
  if (bh <= 0.01 || hr < 0.5) return;
  const wire = wireRgb(colors);
  const bright = mixRgb(wire, WHITE, 0.45);
  const dotR = Math.max(0.8, env.size * 0.0042);
  const flatten = 0.9;
  for (let k = 0; k < 12; k++) {
    const speed = 0.55 * (0.7 + (0.3 * ((k * 7) % 5)) / 4);
    const cyc = tSec * speed + k * 0.173;
    const u = cyc % 1;
    const gen = Math.floor(cyc);
    const ang = k * 2.399 + gen * 1.71 + (k % 3) * 0.2;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang) * flatten;
    // Escaping quantum: leaves the rim, decelerates, fades.
    const out = easeOut(u);
    const rr = hr * 1.08 + out * R * QUANTA_REACH_R;
    const a = (1 - u) * (1 - u) * 0.85 * bh;
    ctx.fillStyle = rgba(bright, a * colors.boost);
    ctx.beginPath();
    ctx.arc(c + ca * rr, c + sa * rr, dotR * (1 - u * 0.5), 0, TAU);
    ctx.fill();
    // A short trail behind it.
    const rt = hr * 1.08 + easeOut(Math.max(0, u - 0.06)) * R * QUANTA_REACH_R;
    ctx.strokeStyle = rgba(bright, a * 0.35 * colors.boost);
    ctx.lineWidth = dotR * 0.8;
    ctx.beginPath();
    ctx.moveTo(c + ca * rt, c + sa * rt);
    ctx.lineTo(c + ca * rr, c + sa * rr);
    ctx.stroke();
    // Its partner falls in and is gone within the first third of the cycle.
    if (u < 0.32) {
      const v = u / 0.32;
      const ri = hr * (1.06 - 0.32 * v);
      ctx.fillStyle = rgba(wire, (1 - v) * 0.6 * bh * colors.boost);
      ctx.beginPath();
      ctx.arc(c + ca * ri, c + sa * ri, dotR * 0.8, 0, TAU);
      ctx.fill();
    }
  }
}

/**
 * Painted AFTER the crisp geometry: the disk's streamlines with their lensed
 * far side, the secondary image under the shadow, the wound wires, and the
 * escaping quanta. The eyes are drawn by the caller on top, as in every
 * other state.
 */
export function drawBlackholeOver(env: BhEnv): void {
  const { ctx, bh, c, R, colors } = env;
  if (bh <= 0.03) return;
  const rsFull = R * SHADOW_K;
  const hr = blackholeShadowRadius(bh, R);
  const inner = LENS_INNER * rsFull;
  const outer = LENS_OUTER_R * R;
  const form = clamp01((bh - 0.2) / 0.8);
  const tmp: [number, number] = [0, 0];
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Streamlines of the disk: five rings from the ISCO out. Each is one closed
  // curve - near side below, far side lifted over the top - so the disk and
  // its lensed image are literally the same ring. The approaching (left)
  // side is beamed brighter.
  const N = 5;
  const segs = 64;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const rho = inner + (outer - inner) * t ** 1.15;
    const alpha = (0.55 - 0.22 * t) * form * colors.boost;
    ctx.strokeStyle = dopplerStroke(env, outer, alpha, 0.6);
    ctx.lineWidth = Math.max(1, env.size * 0.0045) * (1.25 - 0.4 * t);
    ctx.beginPath();
    for (let s = 0; s <= segs; s++) {
      lensedPoint(c, hr, rho, (s / segs) * TAU, tmp);
      if (s === 0) ctx.moveTo(tmp[0], tmp[1]);
      else ctx.lineTo(tmp[0], tmp[1]);
    }
    ctx.closePath();
    ctx.stroke();
  }
  // The secondary image: the disk's underside seen below the shadow,
  // squeezed into a thin dim arc hugging the rim (Luminet's lower arc).
  const sec = form * 0.5 * colors.boost;
  for (let k = 0; k < 3; k++) {
    const rr = hr * (1.12 + 0.07 * k);
    ctx.strokeStyle = dopplerStroke(env, outer, sec * (1 - k * 0.25), 0.35);
    ctx.lineWidth = Math.max(0.8, env.size * 0.0028);
    ctx.beginPath();
    ctx.ellipse(
      c,
      c + hr * 0.04,
      rr * (1.0 + 0.25 * k),
      rr * 0.62,
      0,
      Math.PI * 0.2,
      Math.PI * 0.8,
    );
    ctx.stroke();
  }
  // The character's own wires, wound into the disk as connected streamlines
  // that follow the disk and ride up its lensed image.
  drawDiskChain(env, hr);
  // Hawking pairs at the rim, escaping radially.
  drawHawkingPairs(env, hr);
}
