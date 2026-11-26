import { clamp01, easeInOut, noise1, TAU } from "./face";
import { mixRgb, rgba, type SkyColors, type SkyDots, type SkyPt, WHITE } from "./sky";

// A spiral galaxy seen almost face on: the vertices swirl out along two
// logarithmic arms while the eyes keep the bulge, the whole disc turns
// slowly with the arms trailing, and faint field stars ride the arms. A
// face-on cousin of the black hole's inclined disc.
//
// Honesty notes: the arms are logarithmic spirals with a pitch like M51's;
// the turn is many orders of magnitude too fast, as every galaxy animation
// is. The spin turns the angle only, never the radius (a prototype bug
// worth pinning: a spin folded into the exponent shrinks the arms to
// nothing as the clock runs).

export const GALAXY = {
  /** The arm's radius at azimuth 0, in units of R. */
  r0: 0.3,
  /** The logarithmic pitch: r = r0 * exp(pitch * theta). */
  pitch: 0.42,
  /** Minor over major of the disc: almost face on. */
  q: 0.78,
  /** The disc's tilt on screen, rad. */
  tilt: -0.35,
  /** The disc's turn, rad/s (negative: arms trail). */
  spin: -0.28,
  /** Where the 8 vertices of an arm sit along it, in azimuth: start and step. */
  armStart: 0.25,
  armStep: 0.45,
  /** How far the drawn arm runs, in azimuth from `armFrom`. */
  armFrom: -0.3,
  armSpan: 3.6,
  /** The dreamy lid while the galaxy holds. */
  lid: 0.12,
} as const;

export const galaxySpin = (tSec: number): number => tSec * GALAXY.spin;

/**
 * A point of arm `arm` (0 or 1, half a turn apart) at azimuth `th` along the
 * spiral, with the disc turned by `spin`, on screen. The radius depends on
 * `th` alone.
 */
export function galaxyArmPoint(
  arm: 0 | 1,
  th: number,
  spin: number,
  c: number,
  R: number,
  out: [number, number],
): [number, number] {
  const r = R * GALAXY.r0 * Math.exp(GALAXY.pitch * th);
  const a = th + spin + arm * Math.PI;
  const x = Math.cos(a) * r;
  const y = Math.sin(a) * r * GALAXY.q;
  const ct = Math.cos(GALAXY.tilt);
  const st = Math.sin(GALAXY.tilt);
  out[0] = c + x * ct - y * st;
  out[1] = c + x * st + y * ct;
  return out;
}

/** The arm and the azimuth along it that vertex `i` settles on. */
export const galaxySlot = (i: number): { arm: 0 | 1; th: number; u: number } => ({
  arm: (i & 1) as 0 | 1,
  th: GALAXY.armStart + (i >> 1) * GALAXY.armStep,
  u: (i >> 1) / 7,
});

/**
 * Swirl the vertices out onto the arms by the envelope `k`: inner slots
 * first, each vertex swinging tangentially around the center on its way
 * (the black hole's wind-up, turned outward). `progress[i]` reports how far
 * vertex i has settled; `dots` takes a size lift toward the bulge and a
 * twinkle.
 */
export function placeGalaxyVertices(
  k: number,
  pts: SkyPt[],
  c: number,
  R: number,
  tSec: number,
  progress: Float64Array,
  dots: SkyDots,
): void {
  if (k <= 0.001) return;
  const spin = galaxySpin(tSec);
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < 16; i++) {
    const { arm, th, u } = galaxySlot(i);
    const bi = easeInOut(clamp01(k * 1.6 - u * 0.6));
    progress[i] = bi;
    if (bi <= 0) continue;
    galaxyArmPoint(arm, th, spin, c, R, tmp);
    const p = pts[i] as SkyPt;
    const sw = bi * 1.4;
    const cs = Math.cos(sw);
    const sn = Math.sin(sw);
    const dx = p[0] - c;
    const dy = p[1] - c;
    const sx = c + dx * cs - dy * sn;
    const sy = c + dx * sn + dy * cs;
    p[0] = sx + (tmp[0] - sx) * bi;
    p[1] = sy + (tmp[1] - sy) * bi;
    p[3] += (0.6 - p[3]) * bi;
    dots.scale[i] = (dots.scale[i] as number) * (1 + 0.25 * bi * (1 - u));
    dots.fade[i] = (dots.fade[i] as number) * (1 + 0.15 * noise1(tSec * 4 + i) * bi);
  }
}

export type GalaxyEnv = {
  ctx: CanvasRenderingContext2D;
  /** The envelope this frame, > 0. */
  k: number;
  c: number;
  R: number;
  size: number;
  tSec: number;
  colors: SkyColors;
};

/**
 * Painted BEFORE the crisp geometry: the bulge's glow behind the eyes, the
 * two arms as a soft wide stroke under a thin bright one, and the field
 * stars scattered along them.
 */
export function drawGalaxyUnder(env: GalaxyEnv): void {
  const { ctx, k, c, R, tSec, colors } = env;
  const e = easeInOut(clamp01(k));
  if (e <= 0.01) return;
  const spin = galaxySpin(tSec);
  const tmp: [number, number] = [0, 0];
  ctx.save();
  const bulge = ctx.createRadialGradient(c, c, 0, c, c, R * 0.62);
  bulge.addColorStop(0, rgba(mixRgb(colors.acc, WHITE, 0.6), 0.45 * e));
  bulge.addColorStop(0.5, rgba(colors.acc, 0.14 * e));
  bulge.addColorStop(1, rgba(colors.acc, 0));
  ctx.fillStyle = bulge;
  ctx.beginPath();
  ctx.ellipse(c, c, R * 0.62, R * 0.5, GALAXY.tilt, 0, TAU);
  ctx.fill();
  ctx.lineCap = "round";
  const SEG = 60;
  for (const arm of [0, 1] as const) {
    for (const pass of [0, 1] as const) {
      ctx.lineWidth = pass ? Math.max(1, env.size * 0.004) : Math.max(3, env.size * 0.018);
      ctx.strokeStyle = rgba(
        pass ? mixRgb(colors.acc, WHITE, 0.3) : colors.acc,
        (pass ? 0.55 : 0.12) * e * colors.boost,
      );
      ctx.beginPath();
      for (let s = 0; s <= SEG; s++) {
        galaxyArmPoint(arm, GALAXY.armFrom + (s / SEG) * GALAXY.armSpan, spin, c, R, tmp);
        if (s === 0) ctx.moveTo(tmp[0], tmp[1]);
        else ctx.lineTo(tmp[0], tmp[1]);
      }
      ctx.stroke();
    }
    // Field stars along the arm, each on its own fixed jitter, twinkling.
    const dotR = Math.max(0.7, env.size * 0.0032);
    for (let d = 0; d < 26; d++) {
      galaxyArmPoint(arm, d * 0.14 + 0.1, spin, c, R, tmp);
      const jx = noise1(d * 2.1 + arm * 9) * R * 0.07;
      const jy = noise1(d * 3.3 + arm * 5) * R * 0.06;
      ctx.fillStyle = rgba(
        mixRgb(colors.acc, WHITE, 0.4),
        (0.25 + 0.2 * noise1(tSec * 3 + d)) * e * colors.boost,
      );
      ctx.beginPath();
      ctx.arc(tmp[0] + jx, tmp[1] + jy, dotR, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}
