import { band, clamp01, easeInOut, noise1, pulse, TAU } from "./face";

// The meteor fidgets: a sky of stars comes out round the first mate and
// meteors cross it. The captain's ask: "a few variants of a meteor shower
// fidget animation to the pool of first mate fidget animations. it should
// look visually pleasing and inspire a sense of awe"; they approved all
// three treatments of the playable preview with its default settings, and
// asked that the storm's start be "the first mate can just fade" instead of
// its points lifting off.
//
// - The shower: meteors on lines through one point of the sky, up and to the
//   right, short near it and long far from it; the brightest crosses behind
//   the first mate and lights it, then the first mate makes a wish.
// - The storm: near-parallel streaks fall in three depths, the nearest in
//   front of the crew; the frame fades where it stands, and its 16 points
//   rain home down the stream, inner cell first, each with a landing glint.
// - The fireball: two faint heralds, then one slow fireball crosses behind
//   the first mate, flaring three times and throwing pieces ahead, with a
//   wake of dust; the first mate turns to follow it.
//
// No outline, ring or filled edge anywhere (the captain's supernova
// feedback). The sky and the meteors are painted on the crew's far canvas
// (./crew/CrewOrbit.tsx), so they reach the crew's orbits and pass behind
// every crewmate; the storm's nearest streaks go on the near canvas, in
// front. The first mate's own part (the hush, its light, the storm's points,
// the eyes and the wish) is drawn by firstmatePainter.ts from the helpers
// here; the crew's light is ./crew/meteors.ts. Positions are px from the
// first mate's center. DOM-free apart from the CanvasRenderingContext2D.

export type MeteorVariant = "shower" | "storm" | "fireball";

export const isMeteor = (v: string | null | undefined): v is MeteorVariant =>
  v === "shower" || v === "storm" || v === "fireball";

/** The captain's settings from the preview card. */
export const METEORS = {
  shower: { durationMs: 6500, meteors: 50, trail: 1, wish: true },
  storm: { durationMs: 6500, meteors: 200, trail: 1 },
  fireball: { durationMs: 7000, fragments: 30, trail: 1 },
  /** Stars in the sky that comes out. */
  stars: 90,
  /** How strongly a meteor's light reaches a crewmate it passes, 0..1. */
  crewLight: 0.6,
  /** How far the sky reaches from the first mate's center, px: inside the crew's 560 px square. */
  reachPx: 276,
} as const;

/** The schedule, as fractions of each fidget. */
export const METEOR_SCHEDULE = {
  /** The hush: the first mate dims and the stars come out, then go. */
  skyIn: 0.02,
  skyInFor: 0.12,
  skyOut: 0.86,
  skyOutFor: 0.12,
  blinkAt: 0.925,
  /** The shower's radiant, in reaches from the center: up and to the right. */
  radiant: [0.5, -0.62],
  showerFrom: 0.15,
  showerFor: 0.66,
  /** The brightest one: when it starts and how long it burns. */
  brightAt: 0.5,
  brightFor: 0.16,
  wishAt: 0.69,
  wishFor: 0.1,
  /** The storm's heading on screen, degrees clockwise from +x: down and to the left. */
  stormDeg: 118,
  stormFrom: 0.09,
  stormFor: 0.72,
  /** The frame fades out whole, wires and points together; the eyes stay. */
  fadeAt: 0.04,
  fadeFor: 0.12,
  /** The points come home down the stream, inner cell first. */
  landAt: 0.58,
  landSpread: 0.22,
  landFor: 0.06,
  /** The fireball's path, in reaches. */
  from: [-1.05, -0.5],
  to: [1.05, 0.22],
  crossAt: 0.2,
  crossFor: 0.44,
  /** Where along the crossing it flares, and how hard. */
  flares: [
    [0.36, 0.5],
    [0.58, 0.7],
    [0.86, 1],
  ],
  /** Its wake of dust falls to a third of its light in this many seconds. */
  trainS: 1.1,
} as const;

const S = METEOR_SCHEDULE;
const REACH = METEORS.reachPx;
/** The first mate's radius at its own 280 px size: the storm's near streaks keep off its face. */
const CORE_R = 280 * 0.27;
/** The storm's points start this far up the stream, beyond the sky's edge. */
const LAND_FAR = REACH * 1.2;

const frac = (v: number): number => v - Math.floor(v);
/** A fixed pseudo-random number in 0..1 for item `i`, stream `k`; the phone reads the tables built from it. */
const hash = (i: number, k: number): number => frac(Math.sin(i * 127.1 + k * 311.7) * 43758.5453);

export const meteorSeconds = (v: MeteorVariant): number => METEORS[v].durationMs / 1000;

/** The hush: 0 at rest, 1 while the sky is out. */
export const meteorHush = (et: number): number =>
  band(et, S.skyIn, S.skyInFor, S.skyOut, S.skyOutFor);

/** The sky fades with no edge toward its reach. */
export const meteorEdge = (x: number, y: number): number =>
  1 - easeInOut(clamp01((Math.hypot(x, y) / REACH - 0.72) / 0.28));

/** The storm's heading. */
export const STORM_DIR: readonly [number, number] = [
  Math.cos((S.stormDeg * Math.PI) / 180),
  Math.sin((S.stormDeg * Math.PI) / 180),
];

/**
 * One meteor: it runs its path from (x0, y0) along (ux, uy) for L px over
 * `life` seconds (or `lifeF` of the fidget), and lingers as a fading train.
 */
export type Meteor = {
  x0: number;
  y0: number;
  ux: number;
  uy: number;
  L: number;
  t0: number;
  life: number;
  /** The brightest one's life, as a share of the fidget; 0 for the rest. */
  lifeF: number;
  mag: number;
  /** Streak width, px. */
  w: number;
  flare: number;
  linger: number;
  /** One of the storm's nearest streaks, drawn in front of the crew. */
  near: boolean;
};

/**
 * The shower: each path is centered on an even scatter of the sky and
 * points straight away from the radiant. Near the radiant paths are short,
 * far from it long; every one lasts about as long, so the far ones run
 * faster, as a real shower looks from the ground. The last is the brightest.
 */
export const SHOWER_METEORS: readonly Meteor[] = (() => {
  const out: Meteor[] = [];
  const rx = S.radiant[0] * REACH;
  const ry = S.radiant[1] * REACH;
  for (let i = 0; i < METEORS.shower.meteors; i++) {
    const r = REACH * Math.sqrt(hash(i, 51)) * 0.96;
    const a = hash(i, 52) * TAU;
    const mx = Math.cos(a) * r;
    const my = Math.sin(a) * r;
    const d = Math.hypot(mx - rx, my - ry) || 1;
    const ux = (mx - rx) / d;
    const uy = (my - ry) / d;
    const L = 18.7 + d * (0.5 + 0.45 * hash(i, 53));
    const big = hash(i, 55) ** 2.2;
    out.push({
      x0: mx - (ux * L) / 2,
      y0: my - (uy * L) / 2,
      ux,
      uy,
      L,
      // One alone first, one alone last; the rest gather toward the middle.
      t0:
        i === 0
          ? 0.085
          : i === 1
            ? 0.885
            : S.showerFrom + S.showerFor * ((hash(i, 56) + hash(i, 57)) / 2) ** 0.9,
      life: 0.45 + 0.5 * hash(i, 54),
      lifeF: 0,
      mag: 0.5 + 0.7 * big,
      w: 1.6 + 2 * big,
      flare: big > 0.45 ? 0.5 : 0,
      linger: big > 0.4 ? 0.4 + 0.7 * big : 0,
      near: false,
    });
  }
  // The brightest one: from beside the radiant, down across the sky behind the first mate.
  const bx0 = 0.33 * REACH;
  const by0 = -0.5 * REACH;
  const bx1 = -0.66 * REACH;
  const by1 = 0.36 * REACH;
  const bl = Math.hypot(bx1 - bx0, by1 - by0);
  out.push({
    x0: bx0,
    y0: by0,
    ux: (bx1 - bx0) / bl,
    uy: (by1 - by0) / bl,
    L: bl,
    t0: S.brightAt,
    life: 1,
    lifeF: S.brightFor,
    mag: 1.5,
    w: 4.6,
    flare: 0.9,
    linger: 1.3,
    near: false,
  });
  return out;
})();

const depth = (z: number, far: number, middle: number, near: number): number =>
  z === 0 ? far : z === 1 ? middle : near;

/**
 * The storm: streaks on near-parallel paths that fan a little from a point
 * far up the stream, in three depths (58% far, 32% middle, 10% near). The
 * nearest are kept off the first mate's face.
 */
export const STORM_METEORS: readonly Meteor[] = (() => {
  const out: Meteor[] = [];
  const fx = -STORM_DIR[0] * REACH * 5;
  const fy = -STORM_DIR[1] * REACH * 5;
  for (let i = 0; i < METEORS.storm.meteors; i++) {
    const h = hash(i, 61);
    const z = h < 0.58 ? 0 : h < 0.9 ? 1 : 2;
    const k = hash(i, 64);
    const r = REACH * Math.sqrt(hash(i, 62));
    const a = hash(i, 63) * TAU;
    let mx = Math.cos(a) * r;
    let my = Math.sin(a) * r;
    const d = Math.hypot(mx - fx, my - fy);
    const ux = (mx - fx) / d;
    const uy = (my - fy) / d;
    if (z === 2) {
      const off = mx * -uy + my * ux;
      const min = CORE_R * 1.25;
      if (Math.abs(off) < min) {
        const add = (off < 0 ? -min : min) - off;
        mx += -uy * add;
        my += ux * add;
      }
    }
    const L = REACH * depth(z, 0.36 + 0.26 * k, 0.6 + 0.4 * k, 1 + 0.5 * k);
    out.push({
      x0: mx - (ux * L) / 2,
      y0: my - (uy * L) / 2,
      ux,
      uy,
      L,
      t0: S.stormFrom + S.stormFor * ((hash(i, 65) + hash(i, 66)) / 2),
      life: depth(z, 0.6 + 0.3 * k, 0.44 + 0.2 * k, 0.32 + 0.14 * k),
      lifeF: 0,
      mag: depth(z, 0.42 + 0.22 * k, 0.62 + 0.3 * k, 0.95 + 0.3 * k),
      w: depth(z, 1.3, 2, 3),
      flare: 0,
      linger: z === 2 ? 0.35 : 0,
      near: z === 2,
    });
  }
  return out;
})();

/** The fireball's path, from its start, in px. */
export const FIREBALL_PATH = (() => {
  const x0 = S.from[0] * REACH;
  const y0 = S.from[1] * REACH;
  const len = Math.hypot(S.to[0] - S.from[0], S.to[1] - S.from[1]) * REACH;
  return {
    x0,
    y0,
    len,
    ux: ((S.to[0] - S.from[0]) * REACH) / len,
    uy: ((S.to[1] - S.from[1]) * REACH) / len,
  };
})();
const FB = FIREBALL_PATH;

/** Two faint heralds before the fireball and one straggler after, on its own heading. */
export const FIREBALL_HERALDS: readonly Meteor[] = (
  [
    [0.07, -0.42, 0.5, 0.5],
    [0.135, 0.3, 0.42, 0.42],
    [0.76, 0.2, 0.46, 0.5],
  ] as const
).map(([t0, off, len, mag]) => ({
  x0: -FB.ux * len * REACH * 0.5 - FB.uy * off * REACH,
  y0: -FB.uy * len * REACH * 0.5 + FB.ux * off * REACH,
  ux: FB.ux,
  uy: FB.uy,
  L: len * REACH,
  t0,
  life: 0.55,
  lifeF: 0,
  mag,
  w: 1.3,
  flare: 0,
  linger: 0,
  near: false,
}));

/** A piece of the fireball: where along the crossing it breaks off, and how it flies. */
export type Fragment = {
  /** Its share of the crossing when it breaks off. */
  u: number;
  /** Its speed as a share of the fireball's. */
  v: number;
  /** How fast the air slows it, 1/s. */
  drag: number;
  /** How far it drifts to one side, px. */
  side: number;
  /** Seconds. */
  life: number;
  w: number;
  a: number;
  /** Its heading's turn from the fireball's, rad: the burst's pieces only. */
  turn: number;
};

/**
 * Two in five break off at its first two flares, the rest all along the
 * crossing. Each keeps the fireball's heading, slows against the air,
 * drifts to one side and sinks a little.
 */
export const FIREBALL_FRAGMENTS: readonly Fragment[] = Array.from(
  { length: METEORS.fireball.fragments },
  (_, j) => {
    const h = hash(j, 71);
    return {
      u:
        h < 0.2
          ? 0.36 + 0.03 * hash(j, 72)
          : h < 0.4
            ? 0.58 + 0.03 * hash(j, 72)
            : 0.14 + 0.7 * hash(j, 72),
      v: 0.82 + 0.18 * hash(j, 73),
      drag: 0.9 + 1.6 * hash(j, 74),
      side: (hash(j, 75) - 0.5) * 2 * (8 + 20 * hash(j, 76)),
      life: 0.8 + 0.9 * hash(j, 77),
      w: 1.4 + 1.7 * hash(j, 78),
      a: 0.65 + 0.35 * hash(j, 79),
      turn: 0,
    };
  },
);

/** The nine pieces it bursts into at its last flare, thrown ahead in a narrow cone. */
export const FIREBALL_BURST: readonly Fragment[] = Array.from({ length: 9 }, (_, j) => ({
  u: S.flares[2][0],
  v: 0.6 + 0.7 * hash(j, 82),
  drag: 2,
  side: 0,
  life: 0.6 + 0.6 * hash(j, 83),
  w: 1.4 + 1.4 * hash(j, 84),
  a: 1,
  turn: (hash(j, 81) - 0.5) * 0.8,
}));

/**
 * The fireball's wake, one grain every 1.5 px of its path: how far it drifts
 * off the line (-1..1), how white it runs, how bright and how big it is (0..1).
 */
export const FIREBALL_DUST: readonly (readonly [number, number, number, number])[] = Array.from(
  { length: Math.floor(FB.len / 1.5) + 1 },
  (_, i) => [hash(i, 85) * 2 - 1, hash(i, 86), hash(i, 87), hash(i, 88)] as const,
);

/** The sky's stars: where, and how bright (0..1). */
export const METEOR_STARS: readonly { x: number; y: number; m: number }[] = Array.from(
  { length: METEORS.stars },
  (_, i) => {
    const r = REACH * Math.sqrt(hash(i, 91)) * 0.98;
    const a = hash(i, 92) * TAU;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, m: hash(i, 93) ** 3 };
  },
);

/** Where a meteor is this frame: its head, its light, and its progress, or null before it starts. */
export function meteorAt(
  m: Meteor,
  et: number,
  secs: number,
): { x: number; y: number; lum: number; u: number; life: number } | null {
  const life = m.lifeF ? m.lifeF * secs : m.life;
  const u = ((et - m.t0) * secs) / life;
  if (u <= 0) return null;
  const d = u < 1 ? m.L * u * (1.12 - 0.12 * u) : m.L;
  const lum =
    u < 1
      ? clamp01(u / 0.1) * (0.8 + 0.2 * Math.sin(u * Math.PI)) * (1 - clamp01((u - 0.88) / 0.12)) +
        m.flare * pulse(u, 0.66, 0.3)
      : 0;
  return { x: m.x0 + m.ux * d, y: m.y0 + m.uy * d, lum, u, life };
}

/** How far along its path the fireball's head is at crossing progress `u`: a touch slower at the end. */
export const fireballRun = (u: number): number => FB.len * u * (1.1 - 0.1 * u);
/** The fireball's flares at crossing progress `u`. */
export const fireballFlare = (u: number): number =>
  S.flares.reduce((s, [at, k]) => s + k * pulse(u, at - 0.035, 0.09), 0);
/** The fireball's light at crossing progress `u`. */
export const fireballLum = (u: number): number =>
  u <= 0 || u >= 1
    ? 0
    : clamp01(u / 0.07) * (0.94 + 0.8 * fireballFlare(u)) * (1 - clamp01((u - 0.9) / 0.1));
/** The fireball's crossing progress at fidget progress `et`. */
export const fireballCross = (et: number): number => (et - S.crossAt) / S.crossFor;

/** When the storm's point of winding rank `rank` starts home, and how far it has come (0..1). */
export function stormLanding(rank: number, et: number): { tl: number; dn: number } {
  const tl = S.landAt + (rank / 15) * S.landSpread;
  return { tl, dn: (et - tl) / S.landFor };
}

/** A storm point raining home: where it is, px from the center, and how far it has come. */
export type StormFlight = { i: number; x: number; y: number; dn: number };

/**
 * The storm's points still falling home this frame, from where each will
 * land (`home`: x, y pairs, px from the center, as the first mate last drew
 * them): fast, then braking onto its place.
 */
export function stormFlights(
  et: number,
  rank: readonly number[],
  home: ArrayLike<number>,
): StormFlight[] {
  const out: StormFlight[] = [];
  for (let i = 0; i < 16; i++) {
    const { dn } = stormLanding(rank[i] ?? 0, et);
    if (dn <= 0 || dn >= 1) continue;
    const gone = (1 - dn) ** 1.6;
    out.push({
      i,
      x: (home[2 * i] ?? 0) - STORM_DIR[0] * LAND_FAR * gone,
      y: (home[2 * i + 1] ?? 0) - STORM_DIR[1] * LAND_FAR * gone,
      dn,
    });
  }
  return out;
}

/** A light a meteor casts this frame: where, how strong, and how far it reaches, px. */
export type MeteorLight = { x: number; y: number; v: number; r: number };

/**
 * What the meteors light this frame, and the brightest one for the eyes to
 * follow. The first mate and the crew read the same lights, so a meteor
 * crossing behind the first mate lights the crew it passes too.
 */
export function meteorLights(
  variant: MeteorVariant,
  et: number,
  flights: readonly StormFlight[] = [],
): { lights: MeteorLight[]; watch: MeteorLight } {
  const lights: MeteorLight[] = [];
  const watch: MeteorLight = { x: 0, y: 0, v: 0, r: 0 };
  const light = (x: number, y: number, v: number, r: number): void => {
    if (v > 0.05) lights.push({ x, y, v, r });
    if (v > watch.v) Object.assign(watch, { x, y, v, r });
  };
  const secs = meteorSeconds(variant);
  if (variant === "fireball") {
    const u = fireballCross(et);
    if (u > 0 && u < 1) {
      const run = fireballRun(u);
      const x = FB.x0 + FB.ux * run;
      const y = FB.y0 + FB.uy * run;
      light(x, y, Math.min(1.6, fireballLum(u)) * meteorEdge(x, y), 230);
    }
    return { lights, watch };
  }
  for (const m of variant === "shower" ? SHOWER_METEORS : STORM_METEORS) {
    if (m.mag <= 0.8) continue;
    const at = meteorAt(m, et, secs);
    if (!at || at.u >= 1) continue;
    const e = meteorEdge(at.x, at.y);
    light(at.x, at.y, Math.min(1.4, m.mag * at.lum * e) * (m.lifeF ? 1 : 0.5), m.lifeF ? 150 : 46);
  }
  for (const f of flights) light(f.x, f.y, 0.6 * meteorEdge(f.x, f.y), 60);
  return { lights, watch };
}

/** How much the lights light a point, 0 and up. */
export function meteorLitAt(lights: readonly MeteorLight[], x: number, y: number): number {
  let m = 0;
  for (const l of lights)
    m = Math.max(m, l.v * clamp01(1 - Math.hypot(x - l.x, y - l.y) / l.r) ** 2);
  return m;
}

/**
 * The first mate's carriage: the hush slows its turn; the fireball turns its
 * frame to follow the crossing (`follow`, -1..1, back to 0 by the end); the
 * shower's wish is one small bow.
 */
export function meteorBody(
  variant: MeteorVariant,
  et: number,
): { hush: number; spin: number; follow: number; wish: number } {
  const hush = meteorHush(et);
  const u = clamp01(fireballCross(et));
  return {
    hush,
    spin: 1 - 0.44 * hush,
    follow:
      variant === "fireball"
        ? (2 * easeInOut(u) - 1) * band(et, S.crossAt - 0.08, 0.1, 0.74, 0.16)
        : 0,
    wish: variant === "shower" && METEORS.shower.wish ? pulse(et, S.wishAt, S.wishFor) : 0,
  };
}

/**
 * The eyes: up at the sky, then on the brightest meteor, on each of the
 * storm's points as it lands, after the fireball as it goes, shut in happy
 * arcs for the wish, and home with a blink before the end. `landed` is the
 * last storm point to land, px from the center.
 */
export function meteorEyes(
  variant: MeteorVariant,
  et: number,
  watch: MeteorLight,
  landed: { x: number; y: number } | null,
  R: number,
): { look: [number, number]; lid: number; wide: number; happy: number } {
  const hush = meteorHush(et);
  const up: [number, number] =
    variant === "storm"
      ? [-STORM_DIR[0] * 0.95, -STORM_DIR[1] * 0.9]
      : variant === "shower"
        ? [0.55, -0.72]
        : [-0.7, -0.5];
  const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
  let look: [number, number] = [up[0] * clamp01(et / 0.08), up[1] * clamp01(et / 0.08)];
  let wide = 1 + 0.14 * hush;
  if (watch.v > 0.45) {
    look = [clamp(watch.x / (REACH * 0.62)), clamp(watch.y / (REACH * 0.62))];
    wide += 0.16 * clamp01(watch.v);
  }
  if (variant === "storm" && landed && et > S.landAt)
    look = [clamp(landed.x / R), clamp(landed.y / R)];
  if (variant === "fireball" && fireballCross(et) >= 1 && et < 0.78) look = [0.75, 0.22];
  const wish = meteorBody(variant, et).wish;
  const happy = wish > 0 ? clamp01(wish * 3) : 0;
  if (wish > 0) look = [0, 0.3];
  if (et > 0.9) look = [0, 0];
  return { look, lid: pulse(et, S.blinkAt, 0.05), wide, happy };
}

/** The storm's landing glints: where, and how far each has faded (0..1). */
export type StormGlint = { x: number; y: number; q: number };

/**
 * The last of the storm's points to land, within a moment of its landing,
 * px from the center (`home` as in stormFlights), or null: the eyes go to it.
 */
export function stormLanded(
  et: number,
  rank: readonly number[],
  home: ArrayLike<number>,
): { x: number; y: number } | null {
  let landed: { x: number; y: number } | null = null;
  let landedAt = -1;
  for (let i = 0; i < 16; i++) {
    const { tl, dn } = stormLanding(rank[i] ?? 0, et);
    if (dn >= 1 && et < tl + 0.12 && tl > landedAt) {
      landedAt = tl;
      landed = { x: home[2 * i] ?? 0, y: home[2 * i + 1] ?? 0 };
    }
  }
  return landed;
}

/**
 * The storm's 16 points. `pts` arrive at their projected positions, written
 * to `home` (x, y pairs from the center `c`) for the crew canvas, which
 * draws each point while it falls home (`drawMeteorSky`). The frame fades
 * where it stands; `progress[i]` is how far point i has left it (the caller
 * fades a wire by the larger of its two ends, so it knits again only once
 * both are home), and `dots` hides a point while it is away and lights it as
 * it lands.
 */
export function placeStormVertices(
  et: number,
  rank: readonly number[],
  pts: readonly (readonly number[])[],
  c: number,
  progress: Float64Array,
  dots: { scale: Float64Array; fade: Float64Array; white: Float64Array },
  home: Float64Array,
): StormGlint[] {
  const glints: StormGlint[] = [];
  for (let i = 0; i < 16; i++) {
    const p = pts[i] as readonly number[];
    const x = (p[0] as number) - c;
    const y = (p[1] as number) - c;
    home[2 * i] = x;
    home[2 * i + 1] = y;
    const { tl, dn } = stormLanding(rank[i] ?? 0, et);
    if (dn <= 0) {
      const gone = easeInOut(clamp01((et - S.fadeAt) / S.fadeFor));
      progress[i] = gone;
      dots.fade[i] = (dots.fade[i] as number) * (1 - gone);
    } else if (dn < 1) {
      progress[i] = 1;
      dots.fade[i] = 0;
    } else {
      const q = (et - tl - S.landFor) / 0.05;
      const glow = 1 - clamp01(q);
      progress[i] = 1 - clamp01(q / 0.8);
      dots.scale[i] = (dots.scale[i] as number) * (1 + 0.5 * glow);
      dots.white[i] = Math.max(dots.white[i] as number, glow);
      dots.fade[i] = (dots.fade[i] as number) * Math.max(glow, 1 - (progress[i] as number));
      if (q < 1) glints.push({ x: p[0] as number, y: p[1] as number, q });
    }
  }
  return glints;
}

export type Rgb = [number, number, number];

export type MeteorColors = {
  /** The wires' own light this frame: ice cyan, ember during a turn. */
  wire: Rgb;
  /** The app background: white light keeps its own ink on a light one. */
  bg: Rgb;
  /** Alpha multiplier from the theme (and a cut-short fidget's release). */
  boost: number;
};

const WHITE: Rgb = [255, 246, 230];
const rgba = (c: Rgb, a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a))})`;
/** A light run toward white-hot. On a light background white would vanish, so it keeps its own ink. */
const blaze = (col: MeteorColors, k: number): Rgb =>
  col.bg[0] + col.bg[1] + col.bg[2] > 380
    ? col.wire
    : [
        col.wire[0] + (WHITE[0] - col.wire[0]) * k,
        col.wire[1] + (WHITE[1] - col.wire[1]) * k,
        col.wire[2] + (WHITE[2] - col.wire[2]) * k,
      ];

/** A tapered streak with no outline, bright at its head (x, y) and gone at its tail. */
function streak(
  ctx: CanvasRenderingContext2D,
  col: MeteorColors,
  x: number,
  y: number,
  ux: number,
  uy: number,
  len: number,
  w: number,
  a: number,
  k: number,
): void {
  if (a < 0.012 || len < 0.8) return;
  const tx = x - ux * len;
  const ty = y - uy * len;
  const nx = -uy * w * 0.5;
  const ny = ux * w * 0.5;
  const g = ctx.createLinearGradient(x, y, tx, ty);
  g.addColorStop(0, rgba(blaze(col, k), a));
  g.addColorStop(0.3, rgba(blaze(col, k * 0.45), a * 0.58));
  g.addColorStop(1, rgba(col.wire, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x + nx, y + ny);
  ctx.lineTo(tx, ty);
  ctx.lineTo(x - nx, y - ny);
  ctx.fill();
}

/** A four-point glint: two hairlines, each fading to nothing at its tips. */
export function meteorGlint(
  ctx: CanvasRenderingContext2D,
  col: MeteorColors,
  x: number,
  y: number,
  arm: number,
  a: number,
): void {
  if (a < 0.012) return;
  ctx.lineWidth = 1;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
  ] as const) {
    const g = ctx.createLinearGradient(x - dx * arm, y - dy * arm, x + dx * arm, y + dy * arm);
    g.addColorStop(0, rgba(col.wire, 0));
    g.addColorStop(0.5, rgba(blaze(col, 0.8), a));
    g.addColorStop(1, rgba(col.wire, 0));
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - dx * arm, y - dy * arm);
    ctx.lineTo(x + dx * arm, y + dy * arm);
    ctx.stroke();
  }
}

/** The storm's landing glints on the first mate's own canvas, over its wires. */
export function drawMeteorStormGlints(
  ctx: CanvasRenderingContext2D,
  glints: readonly StormGlint[],
  col: MeteorColors,
): void {
  for (const g of glints)
    meteorGlint(ctx, col, g.x, g.y, 9 + 9 * (1 - g.q), (1 - g.q) ** 1.5 * col.boost);
}

/** A meteor's head: soft light with no edge, a bright core, and a glint on the bright ones. */
function head(
  ctx: CanvasRenderingContext2D,
  col: MeteorColors,
  x: number,
  y: number,
  w: number,
  a: number,
  glint: boolean,
): void {
  if (a < 0.012) return;
  const r = w * 3.6;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(blaze(col, 0.6), a * 0.55));
  g.addColorStop(0.4, rgba(col.wire, a * 0.16));
  g.addColorStop(1, rgba(col.wire, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(blaze(col, 0.9), a);
  ctx.beginPath();
  ctx.arc(x, y, w * 0.55, 0, TAU);
  ctx.fill();
  if (glint) meteorGlint(ctx, col, x, y, w * 3.2, a * 0.75);
}

/**
 * One meteor at (cx, cy): its streak while it runs, brightening fast and
 * flaring late if it is a bright one, then its train while it lingers.
 */
function drawMeteor(
  ctx: CanvasRenderingContext2D,
  col: MeteorColors,
  m: Meteor,
  et: number,
  secs: number,
  trail: number,
  cx: number,
  cy: number,
): void {
  const at = meteorAt(m, et, secs);
  if (!at) return;
  const reachLen = m.L * (m.lifeF ? 0.85 : 0.66) * trail;
  if (at.u < 1) {
    const x = cx + at.x;
    const y = cy + at.y;
    const a = Math.min(1, m.mag * at.lum * meteorEdge(at.x, at.y) * col.boost);
    const len = Math.min(m.L * at.u * (1.12 - 0.12 * at.u), reachLen);
    if (m.mag > 0.7) streak(ctx, col, x, y, m.ux, m.uy, len * 0.7, m.w * 2.6, a * 0.2, 0.2);
    streak(ctx, col, x, y, m.ux, m.uy, len, m.w, a, 0.5 + 0.4 * at.lum);
    const flare = pulse(at.u, 0.66, 0.3);
    head(ctx, col, x, y, m.w * (m.lifeF ? 1 + 0.5 * flare : 1), a, m.mag > 0.75);
    if (m.lifeF) meteorGlint(ctx, col, x, y, 16 + 50 * flare, a * 0.85);
  } else if (m.linger > 0) {
    const v = ((at.u - 1) * at.life) / m.linger;
    if (v >= 1) return;
    const a = m.mag * 0.34 * (1 - v) ** 2 * meteorEdge(at.x, at.y) * col.boost;
    streak(
      ctx,
      col,
      cx + at.x,
      cy + at.y,
      m.ux,
      m.uy,
      Math.min(m.L, reachLen),
      m.w * (1 - 0.5 * v),
      a,
      0,
    );
  }
}

/** The stars that come out with the hush, each twinkling, the brightest with a small glint. */
function drawStars(
  ctx: CanvasRenderingContext2D,
  col: MeteorColors,
  et: number,
  t: number,
  cx: number,
  cy: number,
): void {
  const k = meteorHush(et);
  if (k < 0.01) return;
  for (const [i, s] of METEOR_STARS.entries()) {
    const al =
      k *
      (0.42 + 0.58 * s.m) *
      (0.72 + 0.28 * noise1(t * 2.2 + i * 1.9)) *
      meteorEdge(s.x, s.y) *
      col.boost;
    ctx.fillStyle = rgba(blaze(col, 0.3 + 0.5 * s.m), al);
    ctx.beginPath();
    ctx.arc(cx + s.x, cy + s.y, 0.8 + 0.9 * s.m, 0, TAU);
    ctx.fill();
    if (s.m > 0.6) meteorGlint(ctx, col, cx + s.x, cy + s.y, 3 + 4 * s.m, al * 0.6);
  }
}

/** The fireball: its wake of dust, its fragments and the burst's pieces, then its head. */
function drawFireball(
  ctx: CanvasRenderingContext2D,
  col: MeteorColors,
  et: number,
  t: number,
  cx: number,
  cy: number,
): void {
  const u = fireballCross(et);
  if (u <= 0) return;
  const crossS = S.crossFor * meteorSeconds("fireball");
  const trail = METEORS.fireball.trail;
  const speed = FB.len / crossS;
  const run = fireballRun(Math.min(u, 1));
  const x0 = cx + FB.x0;
  const y0 = cy + FB.y0;
  // The wake: dust left along the path, each grain twinkling, drifting off
  // the line and sinking a little as it fades. Brighter where it flared.
  for (let s = 0, i = 0; s <= run && i < FIREBALL_DUST.length; s += 1.5, i++) {
    const [drift, ink, bright, big] = FIREBALL_DUST[i] as readonly [number, number, number, number];
    // When the head passed this point, by inverting fireballRun.
    const us = (1.1 - Math.sqrt(1.21 - (0.4 * s) / FB.len)) / 0.2;
    const age = (u - us) * crossS;
    const fade = Math.exp(-age / S.trainS);
    if (fade < 0.03) continue;
    const knot = S.flares.reduce(
      (m, [at, k]) => Math.max(m, k * clamp01(1 - Math.abs(us - at) / 0.06)),
      0,
    );
    const off = drift * (1.2 + (7 + 9 * knot) * (1 - Math.exp(-age * 1.1)));
    const rx = FB.x0 + FB.ux * s - FB.uy * off;
    const ry = FB.y0 + FB.uy * s + FB.ux * off + age * age * 1.4;
    const a = Math.min(
      1,
      fade *
        (0.55 + 0.45 * noise1(t * 8 + i * 2.1)) *
        (0.45 + 0.75 * bright) *
        (1.2 + 1.2 * knot) *
        meteorEdge(rx, ry) *
        col.boost *
        clamp01(us / 0.04),
    );
    if (a < 0.02) continue;
    ctx.fillStyle = rgba(blaze(col, 0.5 * ink), a);
    ctx.beginPath();
    ctx.arc(cx + rx, cy + ry, (0.6 + 0.95 * big) * (1 + 0.5 * knot), 0, TAU);
    ctx.fill();
  }
  // The fragments, each behind the head on its own slowing line.
  for (const f of [...FIREBALL_FRAGMENTS, ...FIREBALL_BURST]) {
    const tau = (u - f.u) * crossS;
    if (tau <= 0 || tau >= f.life) continue;
    const ux = FB.ux * Math.cos(f.turn) - FB.uy * Math.sin(f.turn);
    const uy = FB.ux * Math.sin(f.turn) + FB.uy * Math.cos(f.turn);
    const k = 1 - tau / f.life;
    const v0 = speed * f.v;
    const s0 = fireballRun(Math.min(f.u, 1));
    const along = (v0 * (1 - Math.exp(-tau * f.drag))) / f.drag;
    const vel = v0 * Math.exp(-tau * f.drag);
    const side = f.side * (1 - Math.exp(-tau * 1.4));
    const rx = FB.x0 + FB.ux * s0 + ux * along - uy * side;
    const ry = FB.y0 + FB.uy * s0 + uy * along + ux * side + 7 * tau * tau;
    const a =
      f.a * k ** 1.2 * (0.75 + 0.25 * noise1(t * 9 + f.w * 30)) * meteorEdge(rx, ry) * col.boost;
    streak(ctx, col, cx + rx, cy + ry, ux, uy, Math.max(5.3, vel * 0.16) * trail, f.w, a, 0.5);
    head(ctx, col, cx + rx, cy + ry, f.w * 0.85, a, f.w > 2.2 && k > 0.5);
  }
  if (u >= 1) return;
  // The head: a white core, light with no edge, and a glint that grows with each flare.
  const rx = FB.x0 + FB.ux * run;
  const ry = FB.y0 + FB.uy * run;
  const x = x0 + FB.ux * run;
  const y = y0 + FB.uy * run;
  const fl = fireballFlare(u);
  const a = Math.min(1, fireballLum(u) * meteorEdge(rx, ry) * col.boost);
  const tail = Math.min(run, REACH * 1.05 * trail);
  streak(ctx, col, x, y, FB.ux, FB.uy, tail * 0.5, 30, a * 0.13, 0.1);
  streak(ctx, col, x, y, FB.ux, FB.uy, tail * 0.8, 12, a * 0.42, 0.3);
  streak(ctx, col, x, y, FB.ux, FB.uy, tail, 5, a, 0.85);
  const br = 34 + 40 * fl;
  const g = ctx.createRadialGradient(x, y, 0, x, y, br);
  g.addColorStop(0, rgba(blaze(col, 0.8), a * 0.8));
  g.addColorStop(0.25, rgba(blaze(col, 0.3), a * 0.26));
  g.addColorStop(1, rgba(col.wire, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, br, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(blaze(col, 0.95), a);
  ctx.beginPath();
  ctx.arc(x, y, 3 + 2 * fl, 0, TAU);
  ctx.fill();
  meteorGlint(ctx, col, x, y, 40 + 74 * fl, a * 0.9);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  meteorGlint(ctx, col, 0, 0, 13 + 26 * fl, a * 0.6);
  ctx.restore();
}

/** One meteor fidget on the crew's canvases this frame (./crew/meteors.ts). */
export type MeteorFrame = {
  variant: MeteorVariant;
  /** Progress through the fidget, 0..1, held where a cut-short one stopped. */
  et: number;
  /** Stage time, s: the stars' and the dust's twinkle. */
  t: number;
  /** 1 while it plays; a cut-short one falls to 0 over its release. */
  release: number;
  /** The first mate's radius, px. */
  coreR: number;
  /** 0..1 ember blend (busy). */
  heat: number;
  /** The storm's 16 points where the first mate last drew them, x, y pairs from its center. */
  home: ArrayLike<number>;
  /** Each point's winding rank, inner cell first. */
  rank: readonly number[];
};

/**
 * The sky on one of the crew's canvases, centered at (cx, cy). The far
 * canvas (`near` false) takes the stars, every meteor behind the crew, the
 * fireball and the storm's points falling home; the near canvas only the
 * storm's nearest streaks, in front of the crew and the first mate.
 */
export function drawMeteorSky(
  ctx: CanvasRenderingContext2D,
  f: MeteorFrame,
  cx: number,
  cy: number,
  colors: MeteorColors,
  near: boolean,
): void {
  const col = { ...colors, boost: colors.boost * f.release };
  if (col.boost <= 0.004) return;
  const { variant, et, t } = f;
  const secs = meteorSeconds(variant);
  if (!near) drawStars(ctx, col, et, t, cx, cy);
  if (variant === "shower") {
    if (near) return;
    for (const m of SHOWER_METEORS) drawMeteor(ctx, col, m, et, secs, METEORS.shower.trail, cx, cy);
  } else if (variant === "storm") {
    for (const m of STORM_METEORS) {
      if (m.near === near) drawMeteor(ctx, col, m, et, secs, METEORS.storm.trail, cx, cy);
    }
    if (near) return;
    // The first mate's own points, raining home down the stream.
    for (const p of stormFlights(et, f.rank, f.home)) {
      const e = meteorEdge(p.x, p.y);
      const len = f.coreR * (0.5 + 2.6 * (1 - p.dn)) * METEORS.storm.trail;
      streak(
        ctx,
        col,
        cx + p.x,
        cy + p.y,
        STORM_DIR[0],
        STORM_DIR[1],
        len,
        2.6,
        e * col.boost,
        0.7,
      );
      head(ctx, col, cx + p.x, cy + p.y, 2.4, Math.min(1, e * col.boost), false);
    }
  } else if (!near) {
    for (const m of FIREBALL_HERALDS)
      drawMeteor(ctx, col, m, et, secs, METEORS.fireball.trail, cx, cy);
    drawFireball(ctx, col, et, t, cx, cy);
  }
}
