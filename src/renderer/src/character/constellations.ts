import { clamp01, easeInOut, TAU } from "./face";
import {
  mixRgb,
  type Rgb,
  rgba,
  type SkyColors,
  type SkyDots,
  type SkyPt,
  twinkle,
  WHITE,
} from "./sky";

// Two constellation fidgets: Orion and the Big Dipper. The 16 vertices glide
// onto the figure's stars - on a small arc each, so the wind-up reads as
// stars settling rather than dots sliding - the tesseract's wires fade as
// their ends arrive, and the stick figure traces itself line by line once
// the stars are placed. Star positions are J2000 catalog coordinates laid
// out as a chart: north up, east left, so x runs westward and y southward
// in degrees off the figure's center. Sizes follow magnitude.
//
// Honesty notes, in the black hole's spirit: Orion's 16 are its brightest
// stars plus the sword and shield; the haze below the belt stands for the
// Orion Nebula. The Plough is an asterism of Ursa Major, not a
// constellation; two vertices meet on each of its seven stars and on Alcor,
// whose offset from Mizar is widened about three times so the double reads
// at this size. The captain kept the stars in the character's own light
// (no ember on Betelgeuse) and left out the pointer line to Polaris.

export type Star = {
  /** Degrees west of the figure's center. */
  x: number;
  /** Degrees south of the figure's center. */
  y: number;
  /** Visual magnitude: smaller is brighter. */
  mag: number;
  /** A blue-white star: the dot carries a white core. */
  white?: boolean;
  /** A nebula sits here: a soft haze is painted around the star. */
  nebula?: boolean;
};

export type Constellation = {
  /** Degrees to character radii. */
  scale: number;
  /** Where the figure's center sits, in R off the character's center. */
  offset: readonly [number, number];
  stars: readonly Star[];
  /** The star each of the 16 vertices settles on. */
  slots: readonly number[];
  /** Vertex ids in settling order: the belt first, the outskirts last. */
  order: readonly number[];
  /** The stick figure, as star-index pairs in tracing order. */
  lines: readonly [number, number][];
  /** Where the eyes look while the figure holds, in gaze units. */
  gaze: readonly [number, number];
};

const star = (x: number, y: number, mag: number, extra: Partial<Star> = {}): Star => ({
  x,
  y,
  mag,
  ...extra,
});

/** Orion, the Hunter: the figure centered on the belt, shifted so the eyes sit in the torso. */
export const ORION: Constellation = {
  scale: 0.13,
  offset: [0.4, 0.24],
  stars: [
    star(-6.8, -7.4, 0.5), // 0 Betelgeuse
    star(0.7, -6.3, 1.6), // 1 Bellatrix
    star(-3.2, 1.9, 1.8), // 2 Alnitak
    star(-2.05, 1.2, 1.7), // 3 Alnilam
    star(-1, 0.3, 2.2), // 4 Mintaka
    star(-4.9, 9.7, 2.1), // 5 Saiph
    star(3.4, 8.2, 0.1, { white: true }), // 6 Rigel
    star(-1.8, -9.9, 3.4), // 7 Meissa
    star(-1.9, 5.9, 2.8), // 8 Hatysa
    star(-1.8, 5.4, 4, { nebula: true }), // 9 Theta Orionis, the Trapezium
    star(-1.8, 4.8, 4.6), // 10 42 Orionis
    star(9.5, -7, 3.2), // 11 Pi 3
    star(9.2, -5.6, 3.7), // 12 Pi 4
    star(8.4, -2.4, 3.7), // 13 Pi 5
    star(9.3, -8.9, 4.4), // 14 Pi 2
    star(-8.6, -9.6, 4.1), // 15 Mu Orionis
  ],
  slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  order: [3, 4, 2, 1, 0, 6, 5, 7, 10, 9, 8, 11, 12, 13, 14, 15],
  lines: [
    [3, 4],
    [2, 3],
    [0, 2],
    [1, 4],
    [0, 1],
    [7, 0],
    [7, 1],
    [2, 5],
    [4, 6],
    [3, 10],
    [10, 9],
    [9, 8],
    [1, 11],
    [14, 11],
    [11, 12],
    [12, 13],
    [0, 15],
  ],
  gaze: [0.35, 0.55],
};

/** The Big Dipper: bowl to the right, handle to the left, hung below the eyes. */
export const BIG_DIPPER: Constellation = {
  scale: 0.125,
  offset: [0, 0.45],
  stars: [
    star(11.2, -5.75, 1.8), // 0 Dubhe
    star(11.5, -0.4, 2.4), // 1 Merak
    star(4.2, 2.3, 2.4), // 2 Phecda
    star(1.2, -1, 3.3), // 3 Megrez
    star(-4.2, 0, 1.8), // 4 Alioth
    star(-8.4, 1.1, 2.2), // 5 Mizar
    star(-9.1, 0.3, 4), // 6 Alcor
    star(-11.7, 6.7, 1.9), // 7 Alkaid
  ],
  slots: [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7],
  order: [0, 8, 1, 9, 2, 10, 3, 11, 4, 12, 5, 13, 7, 15, 6, 14],
  lines: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [3, 4],
    [4, 5],
    [5, 7],
  ],
  gaze: [0, -0.3],
};

/** A star's dot radius relative to a vertex dot, from its magnitude. */
export const starScale = (mag: number): number => Math.max(0.55, 1.5 - 0.22 * mag);

export function starPoint(
  con: Constellation,
  si: number,
  c: number,
  R: number,
  out: [number, number],
): [number, number] {
  const s = con.stars[si] as Star;
  out[0] = c + (s.x * con.scale + con.offset[0]) * R;
  out[1] = c + (s.y * con.scale + con.offset[1]) * R;
  return out;
}

/** Each vertex's rank in the settling order, 0 first. */
function ranks(con: Constellation): number[] {
  const rank = new Array<number>(16).fill(0);
  con.order.forEach((v, k) => {
    rank[v] = k;
  });
  return rank;
}

const rankCache = new Map<Constellation, number[]>();

/**
 * Move the 16 vertices onto the figure's stars by the envelope `k`. `pts`
 * arrive at their projected positions and leave at the blended positions;
 * `progress[i]` reports how far vertex i has settled (the caller fades its
 * wires by it), and `dots` takes each star's size, twinkle and white core.
 * Settling is staggered by rank, like the black hole's wind-up, and each
 * vertex travels on a small arc, alternating sides.
 */
export function placeConstellationVertices(
  k: number,
  con: Constellation,
  pts: SkyPt[],
  c: number,
  R: number,
  tSec: number,
  progress: Float64Array,
  dots: SkyDots,
): void {
  if (k <= 0.001) return;
  let rank = rankCache.get(con);
  if (!rank) {
    rank = ranks(con);
    rankCache.set(con, rank);
  }
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < 16; i++) {
    const u = (rank[i] ?? 0) / 15;
    const bi = easeInOut(clamp01(k * 1.6 - u * 0.6));
    progress[i] = bi;
    if (bi <= 0) continue;
    const si = con.slots[i] ?? 0;
    const s = con.stars[si] as Star;
    starPoint(con, si, c, R, tmp);
    const p = pts[i] as SkyPt;
    const dx = tmp[0] - p[0];
    const dy = tmp[1] - p[1];
    const bulge = Math.sin(bi * Math.PI) * 0.14 * (i & 1 ? 1 : -1);
    p[0] += dx * bi - dy * bulge;
    p[1] += dy * bi + dx * bulge;
    // A settled star reads as the near, bright family.
    p[3] += (0.7 - p[3]) * bi;
    dots.scale[i] = (dots.scale[i] as number) * (1 + (starScale(s.mag) - 1) * bi);
    dots.fade[i] = (dots.fade[i] as number) * (1 + 0.18 * twinkle(tSec * 5 + si * 2.3) * bi);
    if (s.white) dots.white[i] = 0.85 * bi;
    else if (s.nebula) dots.white[i] = 0.35 * bi;
  }
}

export type ConstellationEnv = {
  ctx: CanvasRenderingContext2D;
  /** The envelope this frame, > 0. */
  k: number;
  /** Normalized emote progress, for the tracing schedule. */
  et: number;
  con: Constellation;
  c: number;
  R: number;
  size: number;
  colors: SkyColors;
};

/**
 * Painted AFTER the crisp geometry: the stick figure tracing itself line by
 * line from 0.27 of the emote once the stars are placed, and the nebula
 * haze where the figure carries one. The eyes are drawn by the caller on
 * top, as in every other state.
 */
export function drawConstellationOver(env: ConstellationEnv): void {
  const { ctx, k, et, con, c, R, colors } = env;
  if (k <= 0.02) return;
  const formed = clamp01((k - 0.85) / 0.15);
  if (formed <= 0) return;
  const a: [number, number] = [0, 0];
  const b: [number, number] = [0, 0];
  const line: Rgb = mixRgb(colors.acc, WHITE, 0.25);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, env.size * 0.0043);
  con.lines.forEach(([p, q], j) => {
    const grow = clamp01((et - 0.27 - j * 0.022) / 0.12) * formed;
    if (grow <= 0) return;
    starPoint(con, p, c, R, a);
    starPoint(con, q, c, R, b);
    ctx.strokeStyle = rgba(line, 0.62 * grow * colors.boost);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(a[0] + (b[0] - a[0]) * grow, a[1] + (b[1] - a[1]) * grow);
    ctx.stroke();
  });
  con.stars.forEach((s, si) => {
    if (!s.nebula) return;
    starPoint(con, si, c, R, a);
    const r = R * 0.22;
    const g = ctx.createRadialGradient(a[0], a[1], 0, a[0], a[1], r);
    g.addColorStop(0, rgba(mixRgb(colors.acc, WHITE, 0.3), 0.28 * formed * colors.boost));
    g.addColorStop(1, rgba(colors.acc, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(a[0], a[1], r, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
}
