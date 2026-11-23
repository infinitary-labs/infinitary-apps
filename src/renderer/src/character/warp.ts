import { band, clamp01, easeInOut, noise1, pulse, TAU } from "./face";

// The warp fidgets: the whole crew travelling through space at warp speed,
// as through a wormhole (captain's ask, INF-1750: "i want this fidget
// animation to look like the whole crew is traveling through space at warp
// speed like through a wormhole"). The captain played three treatments on
// the prototype card and chose all three ("add all 3 actually"), with the
// card's settings: six seconds, warp speed 1x, 120 stars.
//
// - tunnel: looking straight down the wormhole; rings pour out from behind
//   the first mate's eyes, stars stretch into streaks, and the crew's tilted
//   orbits open into one flat ring flying beside the first mate.
// - sphere: the first mate opens into a round wormhole with other stars
//   inside it; the crew dive in one after another and come back out.
// - corkscrew: a side view of an hourglass wormhole; the crew peel off their
//   orbits into a spiral line behind the first mate, through the throat.
//
// All three share one timeline - spool up, jump, cruise, exit, settle - and
// one envelope. The first mate's own pose (spin, scale, squint, the sphere)
// is drawn by firstmatePainter.ts from the helpers here; the backdrop (stars, the
// tunnel, the hourglass, the jump and exit rings) is painted on the crew's
// far canvas (./crew/CrewOrbit.tsx), so it reaches the crew's 560 px square
// and passes behind the character; the crew's own moves are ./crew/warp.ts.
//
// Everything is DOM-free apart from the CanvasRenderingContext2D it paints.

export type WarpVariant = "tunnel" | "sphere" | "corkscrew";

export const WARP_VARIANTS: readonly WarpVariant[] = ["tunnel", "sphere", "corkscrew"];

export const isWarp = (v: string | null | undefined): v is WarpVariant =>
  v === "tunnel" || v === "sphere" || v === "corkscrew";

/** The captain's settings from the prototype card (INF-1750's Approve and build). */
export const WARP = {
  /** One warp, start to settle, ms. */
  durationMs: 6000,
  /** How fast the stars and the crew travel, times the prototype's pace. */
  warpSpeed: 1,
  /** Stars streaming past. */
  stars: 120,
  /** How far the backdrop reaches from the first mate's center: half the crew's 560 px square. */
  reachPx: 280,
} as const;

/**
 * The envelope's schedule, as fractions of the fidget: the warp builds from
 * `inAt` over `inFor`, and fades from `outAt` over `outFor`. The jump and the
 * exit fall at `jumpAt` and `exitAt`.
 */
export const WARP_SCHEDULE = {
  inAt: 0.03,
  inFor: 0.17,
  outAt: 0.8,
  outFor: 0.16,
  jumpAt: 0.14,
  exitAt: 0.78,
} as const;

/**
 * The crew's extra travel round their orbits during each warp, in seconds of
 * their own pace for every unit of distance the warp covers. It stays where
 * a warp leaves it, as the black hole's rush does (./crew/rush.ts).
 */
export const WARP_LEAD: Record<WarpVariant, number> = { tunnel: 9, sphere: 5, corkscrew: 4 };

/** The wind-up / cruise / exit envelope, 0..1. */
export const warpEnvelope = (et: number): number =>
  band(et, WARP_SCHEDULE.inAt, WARP_SCHEDULE.inFor, WARP_SCHEDULE.outAt, WARP_SCHEDULE.outFor);

/** How fast the warp travels at `et`, 0..1: a short spool, then the jump, then the exit. */
export function warpSpeed(et: number): number {
  const spool = easeInOut(clamp01((et - WARP_SCHEDULE.inAt) / 0.11)) * 0.16;
  const jump = easeInOut(clamp01((et - WARP_SCHEDULE.jumpAt) / 0.07));
  return (spool + 0.84 * jump) * (1 - easeInOut(clamp01((et - WARP_SCHEDULE.exitAt) / 0.09)));
}

/** Distance covered per second of warp at full speed. */
export const TRAVEL_PER_SECOND = 1.15;
const TRAVEL_STEPS = 600;
/** Distance travelled by each sample, integrated once so a held frame is exact; the phone reads it generated. */
export const WARP_TRAVEL = (() => {
  const table = new Float64Array(TRAVEL_STEPS + 1);
  const seconds = WARP.durationMs / 1000;
  let acc = 0;
  for (let i = 1; i <= TRAVEL_STEPS; i++) {
    acc +=
      (warpSpeed((i - 0.5) / TRAVEL_STEPS) * TRAVEL_PER_SECOND * WARP.warpSpeed * seconds) /
      TRAVEL_STEPS;
    table[i] = acc;
  }
  return table;
})();

export function warpTravel(et: number): number {
  const f = clamp01(et) * TRAVEL_STEPS;
  const i = Math.floor(f);
  if (i >= TRAVEL_STEPS) return WARP_TRAVEL[TRAVEL_STEPS] as number;
  const a = WARP_TRAVEL[i] as number;
  return a + ((WARP_TRAVEL[i + 1] as number) - a) * (f - i);
}

/**
 * The crew's travel speed during a warp, times normal: their own pace plus
 * the warp's lead, which is `WARP_LEAD` seconds per unit of distance.
 */
export const warpCrewTravel = (variant: WarpVariant, speed: number): number =>
  1 + WARP_LEAD[variant] * TRAVEL_PER_SECOND * WARP.warpSpeed * speed;

/**
 * One warp this frame: which, how far through (`et`), its envelope `k`,
 * speed `sp`, distance `tv` and stage time `t` in seconds; `coreR` is the
 * first mate's radius and `heat` its ember, so the backdrop matches it.
 */
export type WarpFrame = {
  variant: WarpVariant;
  et: number;
  k: number;
  sp: number;
  tv: number;
  t: number;
  coreR: number;
  heat: number;
};

/**
 * How the first mate carries itself through each warp: extra spin on its
 * two rotations (rad/s), a breath of scale, a jitter in units of its
 * radius, a squint, a held look, the glow lifted, and the corkscrew's lean.
 */
export type WarpPose = {
  sa: number;
  sb: number;
  scale: number;
  jitter: number;
  lid: number;
  look: [number, number];
  glow: number;
  sx: number;
  sy: number;
  rot: number;
};

export function warpPose(variant: WarpVariant, et: number): WarpPose {
  const k = warpEnvelope(et);
  const sp = warpSpeed(et);
  if (variant === "tunnel") {
    return {
      sa: 0.55 * k,
      sb: 0.3 * k,
      scale: 1 - 0.07 * pulse(et, 0.03, 0.14) + 0.05 * pulse(et, 0.13, 0.12),
      jitter: 0.025 * sp,
      lid: 0.3 * k,
      look: [0, 0.05],
      glow: 1 + 1.3 * k,
      sx: 1,
      sy: 1,
      rot: 0,
    };
  }
  if (variant === "sphere") {
    return {
      sa: 0.12 * k,
      sb: 0,
      scale: 1,
      jitter: 0,
      lid: 0,
      look: [0, 0],
      glow: 1 + 0.86 * k,
      sx: 1,
      sy: 1,
      rot: 0,
    };
  }
  return {
    sa: 0.35 * k,
    sb: 0,
    scale: 1,
    jitter: 0,
    lid: 0.18 * k,
    look: [0.9, 0],
    glow: 1 + 1.14 * k,
    sx: 1 + 0.12 * sp,
    sy: 1 - 0.06 * sp,
    rot: 0.12 * k,
  };
}

/** The sphere's radius at `et`, px, for a first mate of radius `R`: it opens, swells as the crew pass through, and closes. */
export function sphereRadius(et: number, R: number): number {
  const k = warpEnvelope(et);
  return R * 1.12 * easeInOut(clamp01(k * 1.4)) * (1 + 0.22 * pulse(et, 0.45, 0.13));
}

/**
 * The sphere: the 16 vertices take their places on its rim, inner cell first,
 * swirling in as the black hole's do. `rank` is the black hole's winding
 * rank; `progress[i]` reports how far vertex i has gone (the caller fades
 * its wires by it).
 */
export function placeSphereVertices(
  et: number,
  rank: readonly number[],
  pts: Array<[number, number, number, number]>,
  c: number,
  R: number,
  tSec: number,
  progress: Float64Array,
): void {
  const k = warpEnvelope(et);
  if (k <= 0.001) return;
  const rs = sphereRadius(et, R);
  for (let i = 0; i < 16; i++) {
    const u = (rank[i] ?? 0) / 15;
    const bi = easeInOut(clamp01(k * 1.6 - u * 0.6));
    progress[i] = Math.max(progress[i] ?? 0, bi);
    if (bi <= 0) continue;
    const p = pts[i] as [number, number, number, number];
    const sw = bi * 1.6;
    const dx = p[0] - c;
    const dy = p[1] - c;
    const sx = c + dx * Math.cos(sw) - dy * Math.sin(sw);
    const sy = c + dx * Math.sin(sw) + dy * Math.cos(sw);
    const ang = ((rank[i] ?? 0) / 16) * TAU + tSec * 0.5;
    p[0] = sx + (c + Math.cos(ang) * rs * 1.02 - sx) * bi;
    p[1] = sy + (c + Math.sin(ang) * rs * 1.02 - sy) * bi;
  }
}

export type Rgb = [number, number, number];

const WHITE: Rgb = [255, 246, 230];
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgba = (c: Rgb, a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a))})`;

/** The same stars on every computer: a fixed Park-Miller sequence, as the phone draws them. */
function starField() {
  let seed = 5;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const head: Array<[number, number, number]> = [];
  const side: Array<[number, number, number]> = [];
  for (let i = 0; i < 320; i++) {
    const a = rnd() * TAU;
    const r = Math.sqrt(0.004 + rnd() * 0.996);
    head.push([Math.cos(a) * r, Math.sin(a) * r, rnd()]);
    side.push([rnd() * 2 - 1, rnd() * 2 - 1, 0.25 + 0.75 * rnd()]);
  }
  const inner: Array<[number, number, number]> = [];
  for (let i = 0; i < 80; i++) inner.push([rnd(), rnd() * TAU, 0.4 + 0.6 * rnd()]);
  return { head, side, inner };
}
export const WARP_STARS = starField();

const REACH = WARP.reachPx;
/** Everything fades before the crew square's edge. */
const vignette = (r: number): number => 1 - easeInOut(clamp01((r - REACH * 0.62) / (REACH * 0.38)));

export type WarpColors = {
  acc: Rgb;
  hot: Rgb;
  /** Alpha multiplier from the theme. */
  boost: number;
};

type Backdrop = {
  ctx: CanvasRenderingContext2D;
  w: WarpFrame;
  cx: number;
  cy: number;
  col: Rgb;
  boost: number;
  /** Keeps the first mate's face clear. */
  calm: (r: number) => number;
};

/** Stars rushing toward the viewer, head-on; a sphere's lens pushes them out past its rim. */
function starsHead(b: Backdrop, lens: number): void {
  const { ctx, w, cx, cy, col, boost } = b;
  const F = 83;
  const tail = 0.008 + 0.11 * w.sp * Math.min(1.6, WARP.warpSpeed);
  const bend = (x: number, y: number): [number, number] => {
    if (lens <= 0.5) return [x, y];
    const r = Math.hypot(x, y) || 1e-6;
    const th = (r + Math.sqrt(r * r + 4 * lens * lens)) / 2;
    return [(x / r) * th, (y / r) * th];
  };
  ctx.lineCap = "round";
  for (let i = 0; i < WARP.stars; i++) {
    const s = WARP_STARS.head[i] as [number, number, number];
    let z = (s[2] - w.tv) % 1;
    if (z < 0) z += 1;
    z = Math.max(z, 0.025);
    const zt = Math.min(1, z + tail);
    const zm = (z + zt) / 2;
    const h = bend((s[0] / z) * F, (s[1] / z) * F);
    const m = bend((s[0] / zm) * F, (s[1] / zm) * F);
    const t = bend((s[0] / zt) * F, (s[1] / zt) * F);
    const r = Math.hypot(h[0], h[1]);
    if (r > REACH) continue;
    const near = 1 - z;
    const a = w.k * clamp01(near * 1.8) * vignette(r) * b.calm(r) * (0.3 + 0.7 * near) * boost;
    if (a < 0.01) continue;
    ctx.strokeStyle = rgba(mixRgb(col, WHITE, 0.2 + 0.5 * near), a);
    ctx.lineWidth = 0.6 + 1.3 * near;
    ctx.beginPath();
    ctx.moveTo(cx + t[0], cy + t[1]);
    ctx.lineTo(cx + m[0], cy + m[1]);
    ctx.lineTo(cx + h[0], cy + h[1]);
    ctx.stroke();
  }
}

/** The tunnel, head-on: a glow at its far end, six ribs twisting down its walls, rings pouring out. */
function tunnel(b: Backdrop): void {
  const { ctx, w, cx, cy, col, boost } = b;
  const k = w.k;
  const RT = 67;
  const z0 = w.tv * 0.5;
  // The far end wanders a little, so the wormhole bends as it is flown.
  const off = (z: number): [number, number] => {
    const m = z ** 1.6 * 29 * k;
    return [Math.cos(w.t * 0.55) * m, Math.sin(w.t * 0.43 + 1) * m];
  };
  const o = off(1);
  const g = ctx.createRadialGradient(cx + o[0], cy + o[1], 0, cx + o[0], cy + o[1], 69);
  g.addColorStop(0, rgba(mixRgb(col, WHITE, 0.6), 0.26 * k * boost));
  g.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = g;
  ctx.fillRect(cx - 80 + o[0], cy - 80 + o[1], 160, 160);
  ctx.lineCap = "round";
  ctx.lineWidth = 0.8;
  for (let m = 0; m < 6; m++) {
    let px = 0;
    let py = 0;
    for (let s = 0; s <= 18; s++) {
      const z = 1 - (s / 18) * 0.8;
      const r = RT / z;
      const q = off(z);
      const ang = (m / 6) * TAU + (z + z0) * 2.4;
      const x = cx + q[0] + Math.cos(ang) * r;
      const y = cy + q[1] + Math.sin(ang) * r;
      if (s > 0) {
        ctx.strokeStyle = rgba(col, 0.2 * k * vignette(r) * clamp01((1 - z) * 3) * boost);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      px = x;
      py = y;
    }
  }
  const NR = 11;
  for (let j = 0; j < NR; j++) {
    let z = (j / NR - z0) % 1;
    if (z < 0) z += 1;
    if (z < 0.2) continue;
    const r = RT / z;
    const q = off(z);
    ctx.strokeStyle = rgba(
      mixRgb(col, WHITE, 0.25 * (1 - z)),
      k * clamp01((1 - z) * 2.5) * vignette(r) * 0.6 * boost,
    );
    ctx.lineWidth = 0.7 + 1.2 * (1 - z);
    ctx.beginPath();
    ctx.arc(cx + q[0], cy + q[1], r, 0, TAU);
    ctx.stroke();
  }
  starsHead(b, 0);
}

/** The hourglass wormhole's half-height at `x` px from the first mate, for a first mate of radius `R`. */
export const tubeRadius = (x: number, R: number): number =>
  Math.sqrt((R * 1.3) ** 2 + 0.72 * x * x);
const SPAN = 560;
const Q = 0.3;
const endFade = (x: number): number => Math.sin(Math.PI * clamp01((x + SPAN / 2) / SPAN)) ** 1.8;

/** The corkscrew's wormhole, side-on: streaming stars, its silhouette, twisting stripes and rings flowing through the throat. */
function tube(b: Backdrop): void {
  const { ctx, w, cx, cy, col, boost } = b;
  const k = w.k;
  const R = w.coreR;
  ctx.lineCap = "round";
  const stretch = Math.min(1.6, WARP.warpSpeed);
  for (let i = 0; i < WARP.stars * 0.6; i++) {
    const s = WARP_STARS.side[i] as [number, number, number];
    const d = s[2];
    let x = (s[0] * REACH - w.tv * 347 * d) % (2 * REACH);
    if (x < -REACH) x += 2 * REACH;
    if (x > REACH) x -= 2 * REACH;
    const y = s[1] * REACH * 0.92;
    const r = Math.hypot(x, y);
    const a = k * (0.2 + 0.6 * d) * vignette(r) * b.calm(r) * boost * 0.8;
    if (a < 0.01) continue;
    ctx.strokeStyle = rgba(mixRgb(col, WHITE, 0.2 + 0.4 * d), a);
    ctx.lineWidth = 0.5 + 1.1 * d;
    ctx.beginPath();
    ctx.moveTo(cx + x, cy + y);
    ctx.lineTo(cx + x + 4 + w.sp * 83 * d * stretch, cy + y);
    ctx.stroke();
  }
  const sc = w.tv * 267;
  ctx.lineWidth = 1.1;
  for (const sg of [-1, 1]) {
    for (let s = 0; s < 42; s++) {
      const x1 = -SPAN / 2 + (s / 42) * SPAN;
      const x2 = x1 + SPAN / 42;
      ctx.strokeStyle = rgba(col, 0.42 * k * endFade((x1 + x2) / 2) * boost);
      ctx.beginPath();
      ctx.moveTo(cx + x1, cy + sg * tubeRadius(x1, R));
      ctx.lineTo(cx + x2, cy + sg * tubeRadius(x2, R));
      ctx.stroke();
    }
  }
  ctx.lineWidth = 0.8;
  for (let m = 0; m < 6; m++) {
    let px = 0;
    let py = 0;
    for (let s = 0; s <= 40; s++) {
      const x = -SPAN / 2 + (s / 40) * SPAN;
      const r = tubeRadius(x, R);
      const ph = (m / 6) * TAU + (x - sc) * 0.00825;
      const X = cx + x + Q * r * Math.sin(ph);
      const Y = cy - r * Math.cos(ph);
      if (s > 0) {
        ctx.strokeStyle = rgba(col, 0.15 * k * endFade(x) * (Math.sin(ph) > 0 ? 1 : 0.45) * boost);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(X, Y);
        ctx.stroke();
      }
      px = X;
      py = Y;
    }
  }
  const NR = 10;
  const gap = SPAN / NR;
  for (let j = 0; j < NR; j++) {
    const x = ((((j * gap - sc) % SPAN) + SPAN) % SPAN) - SPAN / 2;
    const r = tubeRadius(x, R);
    const a = k * endFade(x) * 0.5 * boost;
    ctx.lineWidth = 0.7 + 0.6 * endFade(x);
    ctx.strokeStyle = rgba(col, a * 0.5);
    ctx.beginPath();
    ctx.ellipse(cx + x, cy, Q * r, r, 0, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.stroke();
    ctx.strokeStyle = rgba(mixRgb(col, WHITE, 0.2), a);
    ctx.beginPath();
    ctx.ellipse(cx + x, cy, Q * r, r, 0, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }
}

/**
 * The corkscrew's place `s` along its spiral (0 nearest the first mate) for
 * `n` riders: px from the first mate's center, and how near the viewer it is
 * (-1 behind .. 1 in front).
 */
export function helixAt(s: number, n: number, w: WarpFrame): { x: number; y: number; z: number } {
  const gap = Math.min(35, 253 / Math.max(n, 1));
  const x = -(64 + gap * s);
  const rho = tubeRadius(x, w.coreR) * 0.62;
  const ph = w.tv * 2.2 + w.t * 0.8 - s * Math.min(0.78, 9 / Math.max(n, 1));
  return { x: x + Q * rho * Math.sin(ph), y: -rho * Math.cos(ph), z: Math.sin(ph) };
}

/**
 * The backdrop, painted on the crew's far canvas under every crewmate:
 * the variant's wormhole and stars, the corkscrew's faint track for `riders`
 * crew, and one ring of light at the jump and one at the exit.
 */
export function drawWarpBackdrop(
  ctx: CanvasRenderingContext2D,
  w: WarpFrame,
  cx: number,
  cy: number,
  colors: WarpColors,
  riders: number,
): void {
  if (w.k <= 0.001) return;
  const col = mixRgb(colors.acc, colors.hot, w.heat);
  const R = w.coreR;
  const b: Backdrop = {
    ctx,
    w,
    cx,
    cy,
    col,
    boost: colors.boost,
    calm: (r) => 0.15 + 0.85 * easeInOut(clamp01((r - R * 0.85) / (R * 1.1))),
  };
  ctx.save();
  if (w.variant === "tunnel") tunnel(b);
  else if (w.variant === "sphere") starsHead(b, sphereRadius(w.et, R));
  else {
    tube(b);
    if (riders > 0) {
      ctx.lineWidth = 1.1;
      let prev = helixAt(-0.6, riders, w);
      for (let s = -4; s <= (riders - 1) * 8 + 4; s++) {
        const h = helixAt(s / 8, riders, w);
        ctx.strokeStyle = rgba(col, (0.12 + (0.24 * (h.z + 1)) / 2) * w.k * w.k * colors.boost);
        ctx.beginPath();
        ctx.moveTo(cx + prev.x, cy + prev.y);
        ctx.lineTo(cx + h.x, cy + h.y);
        ctx.stroke();
        prev = h;
      }
    }
  }
  for (const [at, span] of [
    [WARP_SCHEDULE.jumpAt - 0.005, 0.1],
    [WARP_SCHEDULE.exitAt - 0.005, 0.11],
  ] as const) {
    const u = (w.et - at) / span;
    if (u <= 0 || u >= 1) continue;
    ctx.strokeStyle = rgba(mixRgb(col, WHITE, 0.5), 0.55 * (1 - u) * colors.boost);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, R + (REACH * 0.95 - R) * easeInOut(u), 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The sphere itself, on the first mate's canvas under its wires: the
 * background swallowing what is inside, the far side's stars bent into arcs
 * toward the rim, and a bright rim that flares as the crew pass through.
 */
export function drawWarpSphere(
  ctx: CanvasRenderingContext2D,
  et: number,
  c: number,
  R: number,
  tSec: number,
  colors: { bright: Rgb; bg: Rgb; boost: number },
): void {
  const k = warpEnvelope(et);
  const rs = sphereRadius(et, R);
  if (rs < 0.5) return;
  const col = colors.bright;
  ctx.save();
  ctx.fillStyle = rgba(colors.bg, 0.95 * clamp01(k * 1.5));
  ctx.beginPath();
  ctx.arc(c, c, rs, 0, TAU);
  ctx.fill();
  const g = ctx.createRadialGradient(c, c, 0, c, c, rs);
  g.addColorStop(0, rgba(mixRgb(col, WHITE, 0.4), 0.13 * k));
  g.addColorStop(1, rgba(col, 0.03 * k));
  ctx.fillStyle = g;
  ctx.fill();
  const swirl = tSec * 0.22 + 5 * easeInOut(clamp01((et - 0.44) / 0.14));
  ctx.lineCap = "round";
  const far = mixRgb(col, WHITE, 0.55);
  for (const [u, a0, br] of WARP_STARS.inner) {
    const rho = rs * (0.1 + 0.86 * u ** 0.55);
    const len = 0.03 + 0.55 * u ** 5;
    const ang = a0 + swirl * (1.25 - u * 0.5);
    ctx.strokeStyle = rgba(far, k * br * 0.8 * (0.35 + 0.65 * u) * colors.boost);
    ctx.lineWidth = 0.6 + 0.9 * br;
    ctx.beginPath();
    ctx.arc(c, c, rho, ang, ang + len);
    ctx.stroke();
  }
  const through = pulse(et, 0.45, 0.13);
  ctx.strokeStyle = rgba(mixRgb(col, WHITE, 0.4), (0.12 + 0.2 * through) * k * colors.boost);
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(c, c, rs, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = rgba(mixRgb(col, WHITE, 0.55 + 0.35 * through), 0.85 * k * colors.boost);
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();
}

/** The tunnel's tremble on a vertex or a crewmate: smooth noise, px for a jitter of 1. */
export const warpJitter = (t: number, seed: number): [number, number] => [
  noise1(t * 14 + seed * 3.1),
  noise1(t * 13 + seed * 5.7),
];
