import { band, clamp01, easeInOut, noise1, pulse, TAU } from "./face";

// The supernova fidget: the first mate collapses, goes dark for a beat, then
// bursts into a flash of straight rays, a shell of separate sparks and the
// broken pieces of its own frame, and falls back together. The captain's
// ask: "one more fidget animation added to the pool for the first mate
// character that's somewhat like a supernova explosion"; after the first
// preview, "the outer border doesn't look great. it makes it feel liquidy,
// not something celestial and space-y" and "the explosion can be a bit more
// explosive" - so the blast has no outline, ring or filled edge anywhere.
// The settings are the ones the captain left on the playable preview
// (Approve and build): six seconds, full flash, 80 sparks, the pulsar on,
// a 40 px kick on the crew, and the blast reaching through the crew.
//
// The first mate's own part - the collapse, the 16 vertices flung out and
// falling home, the eyes, the remnant's light - is drawn by
// firstmatePainter.ts from the helpers here. The blast itself (the flash,
// the rays, the afterglow, the pulsar's beams, the shards and the sparks) is
// painted on the crew's far canvas (./crew/CrewOrbit.tsx), so it reaches
// through the crew's orbits and passes behind every crewmate and the
// character; the crew's kick is ./crew/supernova.ts.
//
// Everything is DOM-free apart from the CanvasRenderingContext2D it paints.

/** The captain's settings from the preview card. */
export const SUPERNOVA = {
  /** One supernova, collapse to settle, ms. */
  durationMs: 6000,
  /** The flash's strength, 0..1. */
  flash: 1,
  /** Separate sparks in the shell. */
  sparks: 80,
  /** Two beams turn from the remnant after the blast. */
  pulsar: true,
  /** How far the passing front kicks a crewmate outward at its peak, px. */
  crewKickPx: 40,
  /** How far the front runs from the first mate's center, px: inside the crew's 560 px square. */
  reachPx: 264,
  /** Straight rays in the flash, beside its four spikes. */
  rays: 44,
  /** Pieces of the frame flung out: one for each of its 32 wires. */
  shards: 32,
  /** A spark's streak covers its travel over this long, ms. */
  streakMs: 90,
  /** A crewmate's kick swings out and settles over this long, ms. */
  kickMs: 750,
} as const;

/**
 * The schedule, as fractions of the fidget. The frame falls in from
 * `collapseAt` to `holdAt` and holds there, dark and still, until the
 * bounce at `bounceAt`: the flash lasts `flashFor`, the vertices fly out
 * over `outFor`, the front runs out over `frontFor`, the sparks fade from
 * `fadeAt` over `fadeFor`, and the vertices return from `returnAt` over
 * `returnFor`. The pulsar turns from `pulsarAt` until just before the return.
 */
export const SN_SCHEDULE = {
  collapseAt: 0.05,
  holdAt: 0.195,
  bounceAt: 0.22,
  flashFor: 0.11,
  outFor: 0.16,
  frontFor: 0.3,
  fadeAt: 0.5,
  fadeFor: 0.26,
  returnAt: 0.74,
  returnFor: 0.21,
  pulsarAt: 0.36,
  /** The pulsar's turns a second. */
  pulsarTurns: 0.8,
} as const;

const S = SN_SCHEDULE;

const easeOut3 = (t: number): number => 1 - (1 - t) ** 3;
const frac = (v: number): number => v - Math.floor(v);
/** A fixed pseudo-random number in 0..1 for item `i`, stream `k`; the phone reads the tables built from it. */
const hash = (i: number, k: number): number => frac(Math.sin(i * 127.1 + k * 311.7) * 43758.5453);
/** The golden angle, so neighbours in a table spread round the circle. */
const GOLDEN = 2.399963;

/** How far the frame has fallen in, 0..1, on a cubic curve. */
export const snCollapse = (et: number): number =>
  clamp01((et - S.collapseAt) / (S.holdAt - S.collapseAt)) ** 3;

/**
 * How far the blast's front has run, as a share of its reach: at full speed
 * at once and slowing to a stop on a quartic curve, then a slow 2% drift.
 */
export function snFront(et: number): number {
  const u = clamp01((et - S.bounceAt) / S.frontFor);
  return 1 - (1 - u) ** 4 + 0.02 * clamp01((et - S.bounceAt - S.frontFor) / 0.3);
}

/** When the front reaches `share` of its reach, as a fraction of the fidget. */
export const snFrontAt = (share: number): number =>
  S.bounceAt + S.frontFor * (1 - (1 - clamp01(share)) ** (1 / 4));

/** The blast's light, 1 until the sparks start to fade, 0 once they are gone. */
export const snFade = (et: number): number =>
  et < S.bounceAt ? 0 : 1 - easeInOut(clamp01((et - S.fadeAt) / S.fadeFor));

/** The flash, brightest in its first frame and gone by `flashFor`. */
export function snFlash(et: number): number {
  const u = (et - S.bounceAt) / S.flashFor;
  return u < 0 || u >= 1 ? 0 : (1 - u) ** 2 * SUPERNOVA.flash;
}

/** One spark of the shell: its direction, share of the front, depth and look. */
export type SnSpark = {
  /** Direction on the screen, rad. */
  a: number;
  /** Where it shows, as a share of the front: its speed times its depth's foreshortening. */
  f: number;
  /** 0 = flung away from the viewer, 1 = toward. */
  near: number;
  /** Radius, px. */
  size: number;
  /** Alpha before the fade and the twinkle. */
  alpha: number;
  /** One of the brighter sparks. */
  big: boolean;
  /** A bright spark that glints as a small cross once it slows. */
  glint: boolean;
};

/**
 * The shell: separate sparks flung in every direction in depth. Each has a
 * depth z, even from -1 to 1, and its own speed, 68% to 100% of the front's;
 * seen flat it shows at front x speed x sqrt(1 - z^2), so the sparks crowd
 * toward the edge without ever lining up along it.
 */
export const SN_SPARKS: readonly SnSpark[] = Array.from({ length: SUPERNOVA.sparks }, (_, k) => {
  const z = 1 - 2 * hash(k, 8);
  const near = 0.5 + 0.5 * z;
  const big = hash(k, 10) > 0.7;
  return {
    a: k * GOLDEN + hash(k, 7) * 1.3,
    f: (0.68 + 0.32 * Math.sqrt(hash(k, 13))) * Math.sqrt(1 - z * z),
    near,
    size: (0.65 + 1.2 * hash(k, 10)) * (0.8 + 0.4 * near),
    alpha: (0.4 + 0.6 * hash(k, 9)) * (0.6 + 0.4 * near),
    big,
    glint: big && hash(k, 12) < 0.5,
  };
});

/** One ray of the flash: four long spikes first, then the thin rays. */
export type SnRay = { a: number; len: number; alpha: number; width: number };

export const SN_RAYS: readonly SnRay[] = Array.from({ length: SUPERNOVA.rays + 4 }, (_, k) => {
  const spike = k < 4;
  return {
    a: spike ? (k / 4) * TAU + 0.12 : k * GOLDEN + hash(k, 30) * 0.6,
    len: spike ? (k % 2 ? 0.84 : 1) : 0.34 + 0.6 * hash(k, 31),
    alpha: spike ? 1 : 0.4 + 0.5 * hash(k, 32),
    width: spike ? 2 : 0.7 + 1.1 * hash(k, 33),
  };
});

/** One piece of the frame, flung out and tumbling. */
export type SnShard = {
  a: number;
  /** Where it flies, as a share of the front. */
  r: number;
  /** How fast it tumbles, rad/s at the start, slowing. */
  spin: number;
  /** Its angle as it breaks off, rad. */
  turn: number;
  /** Half its length, in character radii, before it shrinks with the front. */
  half: number;
  alpha: number;
};

export const SN_SHARDS: readonly SnShard[] = Array.from({ length: SUPERNOVA.shards }, (_, j) => ({
  a: j * GOLDEN + hash(j, 40) * 1.1,
  r: 0.2 + 0.42 * hash(j, 41),
  spin: (hash(j, 42) - 0.5) * 9,
  turn: hash(j, 43) * TAU,
  half: 0.6 + 0.6 * hash(j, 44),
  alpha: 0.5 + 0.4 * hash(j, 45),
}));

/** Each vertex's flight: how far out it flies in character radii, and its small head start. */
export const SN_FLING: readonly { far: number; delay: number }[] = Array.from(
  { length: 16 },
  (_, i) => ({ far: 0.9 + 0.6 * hash(i, 11), delay: 0.006 * hash(i, 1) }),
);

/** The direction a vertex flies, from its winding rank (inner cell first). */
export const snFlingAngle = (i: number, rank: number): number =>
  (rank / 16) * TAU + 0.5 + 0.3 * Math.sin(i * 2.4);

/** Projected vertex: screen x, screen y, depth scale, 4D w. */
export type SnPt = [number, number, number, number];

/** A flying vertex's tail of light: where it is, its direction, and its strength. */
export type SnTrail = { x: number; y: number; a: number; k: number };

/** What the placer leaves for the painter's dots: a size and a white-hot core per vertex. */
export type SnDots = { scale: Float64Array; white: Float64Array };

/** The body's size through the collapse: a small swell, then a fall to under a tenth. */
export function snBody(et: number): number {
  if (et >= S.bounceAt) return 1;
  return 1 + 0.08 * pulse(et, 0.03, 0.12) - 0.92 * snCollapse(et);
}

/**
 * Move the 16 vertices for the supernova. `pts` arrive at their normal
 * projected positions. Through the collapse they fall in toward the center,
 * trembling; after the bounce each is a piece of ejecta, out along its own
 * ray and slowing, then back home, inner cell first, with a small swing
 * round the center. `progress[i]` says how far vertex i has left the frame
 * (the caller fades its wires by it); `dots` sizes and lights the dots.
 * Returns the tails of light the flying vertices drag.
 */
export function placeSupernovaVertices(
  et: number,
  rank: readonly number[],
  pts: SnPt[],
  c: number,
  R: number,
  tSec: number,
  progress: Float64Array,
  dots: SnDots,
): SnTrail[] {
  const trails: SnTrail[] = [];
  if (et < S.bounceAt) {
    const ck = snCollapse(et);
    const body = snBody(et);
    for (let i = 0; i < 16; i++) {
      const p = pts[i] as SnPt;
      p[0] = c + (p[0] - c) * body;
      p[1] = c + (p[1] - c) * body;
      if (ck > 0.01) {
        p[0] += noise1(tSec * 19 + i * 3.1) * ck * R * 0.025;
        p[1] += noise1(tSec * 17 + i * 5.7) * ck * R * 0.025;
      }
      dots.scale[i] = (dots.scale[i] as number) * (0.55 + 0.45 * body);
      dots.white[i] = Math.max(dots.white[i] as number, 0.7 * ck);
    }
    return trails;
  }
  const gone = clamp01((et - S.bounceAt) / 0.02);
  for (let i = 0; i < 16; i++) {
    const fling = SN_FLING[i] as { far: number; delay: number };
    const r = rank[i] ?? 0;
    const o = easeOut3(clamp01((et - S.bounceAt - fling.delay) / S.outFor));
    const b = easeInOut(clamp01((et - S.returnAt - (r / 15) * 0.05) / (S.returnFor - 0.05)));
    const p = pts[i] as SnPt;
    const a = snFlingAngle(i, r);
    const far = R * (fling.far + 0.08 * clamp01((et - S.bounceAt) / 0.5));
    const ex = c + Math.cos(a) * far * o;
    const ey = c + Math.sin(a) * far * o;
    // The fall home swings round the center a little, as the black hole's unwind does.
    const sw = (1 - b) * b * 0.6;
    const dx = ex - c;
    const dy = ey - c;
    const fx = c + dx * Math.cos(sw) - dy * Math.sin(sw);
    const fy = c + dx * Math.sin(sw) + dy * Math.cos(sw);
    p[0] = fx + (p[0] - fx) * b;
    p[1] = fy + (p[1] - fy) * b;
    progress[i] = gone * Math.sqrt(1 - b);
    const blown = gone * (1 - b) * (0.4 + 0.6 * (1 - o));
    dots.scale[i] = (dots.scale[i] as number) * (1 + 0.7 * blown);
    dots.white[i] = Math.max(dots.white[i] as number, blown);
    if (o < 0.98 && b <= 0) trails.push({ x: p[0], y: p[1], a, k: (1 - o) ** 1.2 });
  }
  return trails;
}

/**
 * How the frame looks through the collapse: `squeeze` runs its wires white
 * as it falls in, `spin` is the extra turn rate of its fall (rad/s), and
 * `glow` multiplies the ambient light - rising with the collapse, nearly
 * out for the dark beat, jumping at the flash and decaying.
 */
export function supernovaBody(et: number): { squeeze: number; spin: number; glow: number } {
  const ck = snCollapse(et);
  const after = et >= S.bounceAt;
  const hush = after ? 0 : clamp01((et - S.holdAt + 0.012) / 0.014);
  const curve = 0.9 * ck * (after ? 0 : 1) + (after ? 3 * Math.exp(-(et - S.bounceAt) * 10) : 0);
  return {
    squeeze: after ? 0 : ck,
    spin: after ? 0 : 2.4 * ck,
    glow: (1 + curve * SUPERNOVA.flash) * (1 - 0.9 * hush),
  };
}

/**
 * The eyes: braced shut for the collapse and drawn in toward the center
 * (`gather`), then wide open in the afterglow (`wide`), looking left, right
 * and down, and a blink as the frame comes home.
 */
export function supernovaEyes(et: number): {
  look: [number, number];
  lid: number;
  wide: number;
  gather: number;
} {
  let lid: number;
  let wide = 1;
  let gather: number;
  let look: [number, number] = [0, 0.1];
  if (et < S.bounceAt) {
    lid = easeInOut(clamp01((et - 0.07) / 0.1));
    gather = 1 - 0.8 * snCollapse(et);
  } else {
    const open = easeOut3(clamp01((et - S.bounceAt - 0.05) / 0.05));
    lid = 1 - open;
    gather = 0.2 + 0.8 * open;
    wide = 1 + 0.3 * band(et, S.bounceAt + 0.05, 0.04, 0.62, 0.12);
    look =
      et < 0.46 ? [-0.85, -0.35] : et < 0.62 ? [0.85, 0.1] : et < S.returnAt ? [0, 0.55] : [0, 0];
  }
  return { look, lid: Math.max(lid, pulse(et, 0.925, 0.05)), wide, gather };
}

export type Rgb = [number, number, number];

export type SnColors = {
  /** The wires' own light this frame: ice cyan, ember during a turn. */
  wire: Rgb;
  /** The app background: white light keeps its own ink on a light one. */
  bg: Rgb;
  /** Alpha multiplier from the theme. */
  boost: number;
};

const WHITE: Rgb = [255, 246, 230];
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgba = (c: Rgb, a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a))})`;

/** A light run toward white-hot. On a light background white would vanish, so it keeps its own ink. */
export const snBlaze = (col: SnColors, k: number): Rgb =>
  col.bg[0] + col.bg[1] + col.bg[2] > 380 ? col.wire : mixRgb(col.wire, WHITE, k);

/**
 * The remnant's own soft light behind the eyes, painted on the first mate's
 * canvas under the wires.
 */
export function drawSupernovaRemnant(
  ctx: CanvasRenderingContext2D,
  et: number,
  c: number,
  R: number,
  col: SnColors,
): void {
  const k = band(et, S.bounceAt + 0.04, 0.08, S.returnAt, 0.14);
  if (k <= 0.01) return;
  const g = ctx.createRadialGradient(c, c, 0, c, c, R * 0.75);
  g.addColorStop(0, rgba(snBlaze(col, 0.5), 0.3 * k * col.boost));
  g.addColorStop(1, rgba(col.wire, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, R * 0.75, 0, TAU);
  ctx.fill();
}

/** Each flying vertex's tail of light, back toward the center, under the wires. */
export function drawSupernovaTrails(
  ctx: CanvasRenderingContext2D,
  trails: readonly SnTrail[],
  R: number,
  col: SnColors,
): void {
  ctx.lineCap = "round";
  ctx.lineWidth = 1.6;
  for (const t of trails) {
    const len = R * 0.9 * t.k;
    const ex = t.x - Math.cos(t.a) * len;
    const ey = t.y - Math.sin(t.a) * len;
    const g = ctx.createLinearGradient(t.x, t.y, ex, ey);
    g.addColorStop(0, rgba(snBlaze(col, 0.5), 0.7 * t.k * col.boost));
    g.addColorStop(1, rgba(col.wire, 0));
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

/** One supernova on the crew's canvas this frame (./crew/supernova.ts). */
export type SupernovaFrame = {
  /** Progress through the fidget, 0..1, held where a cut-short one stopped. */
  et: number;
  /** Stage time, s: the sparks' twinkle. */
  t: number;
  /** 1 while it plays; a cut-short one falls to 0 over its release. */
  release: number;
  /** The first mate's radius, px. */
  coreR: number;
  /** 0..1 ember blend (busy). */
  heat: number;
};

/** Where each spark of the shell is this frame, px from the center, and its streak's length. */
export function snSparkAt(spark: SnSpark, et: number, reach: number): { r: number; tail: number } {
  const front = reach * snFront(et);
  const before = reach * snFront(et - SUPERNOVA.streakMs / SUPERNOVA.durationMs);
  return { r: front * spark.f, tail: (front - before) * spark.f };
}

/**
 * The blast, painted on the crew's far canvas behind every crewmate and the
 * first mate: the flash's bloom, rays and spikes; the afterglow, a soft
 * light with no edge; the pulsar's two beams; the frame's shards; and the
 * shell of sparks, each on its own straight line with a streak while it is
 * fast and, for the brightest, a glint once it slows.
 */
export function drawSupernovaBlast(
  ctx: CanvasRenderingContext2D,
  f: SupernovaFrame,
  cx: number,
  cy: number,
  col: SnColors,
): void {
  const { et, t, coreR: R } = f;
  if (et < S.bounceAt) return;
  const reach = SUPERNOVA.reachPx;
  const front = reach * snFront(et);
  const fade = snFade(et) * col.boost * f.release;
  if (fade <= 0.004) return;
  const wire = col.wire;
  const bright = snBlaze(col, 0.6);
  const soft = snBlaze(col, 0.25);
  ctx.lineCap = "round";
  const fa = snFlash(et) * f.release;
  if (fa > 0.01) {
    const fu = (et - S.bounceAt) / S.flashFor;
    const hot = snBlaze(col, 0.9);
    const fr = reach * 0.85 * (0.6 + 0.4 * easeOut3(fu));
    const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, fr);
    bloom.addColorStop(0, rgba(hot, fa));
    bloom.addColorStop(0.13, rgba(hot, fa));
    bloom.addColorStop(0.36, rgba(snBlaze(col, 0.45), 0.5 * fa));
    bloom.addColorStop(1, rgba(wire, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(cx, cy, fr, 0, TAU);
    ctx.fill();
    const rayMax = reach * 1.05;
    for (const ray of SN_RAYS) {
      const x = cx + Math.cos(ray.a) * rayMax * ray.len;
      const y = cy + Math.sin(ray.a) * rayMax * ray.len;
      const g = ctx.createLinearGradient(cx, cy, x, y);
      g.addColorStop(0, rgba(hot, Math.min(1, fa * ray.alpha * col.boost)));
      g.addColorStop(1, rgba(wire, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = ray.width;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }
  // The afterglow: soft light where the star was, with no edge anywhere.
  const glowR = front * 0.9 + 1;
  const ga = 0.2 * fade * clamp01((et - S.bounceAt) / S.flashFor / 0.3);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glow.addColorStop(0, rgba(wire, ga));
  glow.addColorStop(0.3, rgba(wire, ga * 0.5));
  glow.addColorStop(0.62, rgba(wire, ga * 0.14));
  glow.addColorStop(1, rgba(wire, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, TAU);
  ctx.fill();
  const secs = (et - S.bounceAt) * (SUPERNOVA.durationMs / 1000);
  if (SUPERNOVA.pulsar) drawPulsar(ctx, f, cx, cy, front, bright, wire, col.boost);
  // The shards: the frame's 32 wires, broken off and tumbling outward.
  const shardA = fade * clamp01(1 - (et - S.fadeAt + 0.1) / 0.2);
  if (shardA > 0.01) {
    ctx.lineWidth = 1.3;
    const shardCol = snBlaze(col, 0.5 * (1 - clamp01(secs / 0.5)));
    for (const s of SN_SHARDS) {
      const r = front * s.r;
      const turn = s.turn + s.spin * (1 - Math.exp(-secs * 1.4));
      const half = R * (0.2 - 0.07 * snFront(et)) * s.half;
      const x = cx + Math.cos(s.a) * r;
      const y = cy + Math.sin(s.a) * r;
      ctx.strokeStyle = rgba(shardCol, shardA * s.alpha);
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(turn) * half, y - Math.sin(turn) * half);
      ctx.lineTo(x + Math.cos(turn) * half, y + Math.sin(turn) * half);
      ctx.stroke();
    }
  }
  for (const [k, spark] of SN_SPARKS.entries()) {
    const { r, tail } = snSparkAt(spark, et, reach);
    const al = fade * (0.7 + 0.3 * noise1(t * 6 + k * 1.7)) * spark.alpha;
    const ux = Math.cos(spark.a);
    const uy = Math.sin(spark.a);
    const x = cx + ux * r;
    const y = cy + uy * r;
    const ink = spark.big ? bright : soft;
    if (tail > 1.5) {
      const g = ctx.createLinearGradient(x, y, x - ux * tail, y - uy * tail);
      g.addColorStop(0, rgba(ink, al * 0.85));
      g.addColorStop(1, rgba(wire, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = spark.size * 1.3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - ux * tail, y - uy * tail);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(ink, al);
    ctx.beginPath();
    ctx.arc(x, y, spark.size, 0, TAU);
    ctx.fill();
    if (spark.glint && tail < 2.5) {
      const arm = spark.size * (2.4 + 1.6 * noise1(t * 4 + k));
      ctx.strokeStyle = rgba(bright, al * 0.6);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y + arm);
      ctx.stroke();
    }
  }
}

/** The pulsar's strength, 0..1: it rises after the blast and is gone before the vertices return. */
export const snPulsar = (et: number): number =>
  SUPERNOVA.pulsar ? band(et, S.pulsarAt, 0.06, S.returnAt - 0.05, 0.08) : 0;

/** The pulsar: two beams from what is left of the star, turning with it, the near one brighter. */
function drawPulsar(
  ctx: CanvasRenderingContext2D,
  f: SupernovaFrame,
  cx: number,
  cy: number,
  front: number,
  bright: Rgb,
  wire: Rgb,
  boost: number,
): void {
  const k = snPulsar(f.et) * f.release;
  if (k <= 0.01) return;
  const a = (f.et - S.pulsarAt) * (SUPERNOVA.durationMs / 1000) * TAU * S.pulsarTurns;
  const bx = Math.cos(a);
  const by = Math.sin(a) * 0.36;
  const len = Math.min(front * 0.9, f.coreR * 2.5) * Math.hypot(bx, by);
  const ang = Math.atan2(by, bx) - 0.38;
  for (const s of [1, -1]) {
    const near = s * Math.sin(a) > 0;
    const d = ang + (s < 0 ? Math.PI : 0);
    const tx = cx + Math.cos(d) * len;
    const ty = cy + Math.sin(d) * len;
    const g = ctx.createLinearGradient(cx, cy, tx, ty);
    g.addColorStop(0, rgba(bright, (near ? 0.5 : 0.28) * k * boost));
    g.addColorStop(1, rgba(wire, 0));
    ctx.fillStyle = g;
    const w = len * 0.07;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx + Math.cos(d + Math.PI / 2) * w, ty + Math.sin(d + Math.PI / 2) * w);
    ctx.lineTo(tx - Math.cos(d + Math.PI / 2) * w, ty - Math.sin(d + Math.PI / 2) * w);
    ctx.fill();
  }
}
