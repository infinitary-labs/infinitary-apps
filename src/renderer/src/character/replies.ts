// Reply emotes: short one-shot reactions the Firstmate performs for the
// trivial replies that carry no card - the steer it passed on, the work it
// sent out, the setting it changed, the note it kept, the thanks it
// received. Each is the character acknowledging the captain in its own body
// language, built from the same parts as the shipped emotes: a pose baked
// into the projected points (so the glow mask and the crisp pass stay
// consistent), a look and lid for the eyes, and line-art garnish in the
// glow color. No new color, no new primitive kind. Captain's board verdict
// (2026-09-22, fm-homes/mini-default/data/fm3000-emote-prototypes-s1/
// report.md): these five ship; the machine plays one asked for during the
// Firstmate's own turn as that turn ends (./machine).
//
// - nod    "Got it."        two nods (a real 3D pitch plus a dip), eyes
//                            squeezed into happy arcs.
// - salute "On it."         revs up: a wind-up squash with narrowed,
//                            determined eyes, then a snapped quarter turn
//                            (the tesseract maps onto itself) with two
//                            motion arcs, landing tall and wide-eyed.
// - tick   "All set."       a light leaves the inner cell and draws a
//                            check beside the structure; the eyes watch it,
//                            then smile.
// - tuck   "Noted."         a loose dot appears above, the eyes find it,
//                            it swoops into the inner cell; a ring closes
//                            in behind it (the notice ring, reversed) and
//                            the eyes give one slow, content blink.
// - aww    "Any time."      bashful: happy eyes glancing down and away,
//                            a shy shrink and sway, line-art blush marks.
//
// DOM-free and time-injected apart from the canvas it paints, like
// ./blackhole and ./notice.

import { isReplyEmote, REPLY_EMOTES, type ReplyEmote } from "@shared/emotes";
import { band, clamp01, easeInOut, easeOut, pulse, TAU } from "./face";

export { isReplyEmote, REPLY_EMOTES, type ReplyEmote };

/** Short on purpose: nod is the emote the app plays most. */
export const REPLY_DURATION_MS: Record<ReplyEmote, number> = {
  nod: 1400,
  salute: 1400,
  tick: 1700,
  tuck: 1800,
  aww: 2000,
};

/** What a reply emote asks of the rig at one moment of its clip. */
export type ReplyFrame = {
  /** Added to the yz rotation, radians: a real 3D pitch (the nod). */
  pitch: number;
  /** Added to the xw rotation, radians: the salute's snap. */
  spin: number;
  /** 2D roll of the whole figure, radians (positive leans clockwise). */
  rot: number;
  /** Translation in units of the canvas size. */
  tx: number;
  ty: number;
  /** Squash and stretch about the center. */
  sx: number;
  sy: number;
  /** Where the eyes look, in gaze units, or null to leave the gaze free. */
  gaze: { x: number; y: number } | null;
  /** Whether the pointer may steer the eyes (the attentive emotes). */
  pointer: boolean;
  /** A floor for the lids (0 open, 1 closed). */
  lid: number;
  /** 0..1; above 0.5 the eyes bend into the happy arc. */
  happy: number;
  /** Hold the random blink off while the clip choreographs the lids. */
  suppressBlink: boolean;
  /** 0..1 lift of the ambient glow. */
  glow: number;
};

const REST: ReplyFrame = {
  pitch: 0,
  spin: 0,
  rot: 0,
  tx: 0,
  ty: 0,
  sx: 1,
  sy: 1,
  gaze: null,
  pointer: true,
  lid: 0,
  happy: 0,
  suppressBlink: false,
  glow: 0,
};

/** The nod's beat: a deeper nod, then a smaller "mm-hm" echo. */
export function nodBeat(et: number): number {
  return pulse(et, 0.05, 0.3) + pulse(et, 0.36, 0.24) * 0.6;
}

/** easeOutBack: overshoots a little and settles - the salute's snap. */
function snapEase(t: number): number {
  const k = 1.9;
  const u = clamp01(t) - 1;
  return 1 + (k + 1) * u * u * u + k * u * u;
}

/** The salute's snap, 0..1 of a quarter turn (the tesseract maps onto itself). */
export function saluteSnap(et: number): number {
  return snapEase((et - 0.2) / 0.24);
}

/** The salute's wind-up before the snap, 0..1..0. */
export function saluteWind(et: number): number {
  return pulse(et, 0, 0.26);
}

// ---- the tick's path, in units of R from the character's center ----
// The check sits low and to the right of the structure, clear of its wires.
const TICK_ANCHOR = { x: 1.12, y: 0.74 };
const TICK_SIZE = 0.44;
const TICK_POINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: -0.5, y: -0.02 },
  { x: -0.14, y: 0.36 },
  { x: 0.6, y: -0.52 },
];
/** Where the pen leaves from: the inner cell, between the eyes. */
const TICK_ORIGIN = { x: 0, y: -0.1 };
const TICK_DRAW = { from: 0.17, to: 0.43 };

function tickPoint(i: number): { x: number; y: number } {
  const p = TICK_POINTS[i] as { x: number; y: number };
  return { x: TICK_ANCHOR.x + p.x * TICK_SIZE, y: TICK_ANCHOR.y + p.y * TICK_SIZE };
}

const TICK_SEGMENTS = (() => {
  const a = tickPoint(0);
  const b = tickPoint(1);
  const c = tickPoint(2);
  const l1 = Math.hypot(b.x - a.x, b.y - a.y);
  const l2 = Math.hypot(c.x - b.x, c.y - b.y);
  return { a, b, c, l1, l2, total: l1 + l2 };
})();

function tickDrawn(et: number): number {
  return easeInOut(clamp01((et - TICK_DRAW.from) / (TICK_DRAW.to - TICK_DRAW.from)));
}

/** A point `d` (0..1) of the way along the check, in R units. */
function alongTick(d: number): { x: number; y: number } {
  const { a, b, c, l1, total } = TICK_SEGMENTS;
  const s = d * total;
  if (s <= l1) {
    const k = s / l1;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }
  const k = (s - l1) / (total - l1);
  return { x: b.x + (c.x - b.x) * k, y: b.y + (c.y - b.y) * k };
}

/** The pen: out of the inner cell to the check's start, then along it. */
function tickPen(et: number): { x: number; y: number } | null {
  if (et < 0.06 || et > TICK_DRAW.to + 0.04) return null;
  if (et < TICK_DRAW.from) {
    const k = easeInOut(clamp01((et - 0.06) / (TICK_DRAW.from - 0.06)));
    const a = TICK_SEGMENTS.a;
    // A slight downward arc on the way out, so it reads as thrown, not slid.
    const sag = Math.sin(k * Math.PI) * 0.12;
    return {
      x: TICK_ORIGIN.x + (a.x - TICK_ORIGIN.x) * k,
      y: TICK_ORIGIN.y + (a.y - TICK_ORIGIN.y) * k + sag,
    };
  }
  return alongTick(tickDrawn(et));
}

// ---- the tuck's dot, in units of R ----
const TUCK_START = { x: 0.58, y: -1.18 };
const TUCK_CTRL = { x: 1.1, y: -0.3 };
const TUCK_HOME = { x: 0, y: -0.04 };
const TUCK_SWOOP = { from: 0.36, to: 0.56 };

/** The tuck's dot at `et`, in R units, or null when it is not out. */
function tuckDot(et: number): { x: number; y: number; alpha: number; r: number } | null {
  if (et < 0.04 || et >= TUCK_SWOOP.to + 0.02) return null;
  if (et < TUCK_SWOOP.from) {
    const rise = easeOut(clamp01((et - 0.04) / 0.12));
    const bob = Math.sin((et - 0.04) * TAU * 2.2) * 0.035 * rise;
    return {
      x: TUCK_START.x,
      y: TUCK_START.y + (1 - rise) * 0.18 + bob,
      alpha: rise,
      r: 1,
    };
  }
  const k = easeInOut(clamp01((et - TUCK_SWOOP.from) / (TUCK_SWOOP.to - TUCK_SWOOP.from)));
  const q = 1 - k;
  return {
    x: q * q * TUCK_START.x + 2 * q * k * TUCK_CTRL.x + k * k * TUCK_HOME.x,
    y: q * q * TUCK_START.y + 2 * q * k * TUCK_CTRL.y + k * k * TUCK_HOME.y,
    alpha: 1,
    r: 1 - 0.35 * k,
  };
}

/** The ring closing in behind the tucked dot: 0..1 progress, or null. */
function tuckRing(et: number): { spread: number; strength: number } | null {
  const u = (et - 0.55) / 0.3;
  if (u <= 0 || u >= 1) return null;
  return { spread: easeInOut(u), strength: Math.sin(u * Math.PI) };
}

/** A gaze target (gaze units) that looks at a point given in R units. */
function lookAt(p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(-1, Math.min(1, p.x * 0.85)),
    y: Math.max(-1, Math.min(1, p.y * 0.8)),
  };
}

/** The rig's ask for a reply emote at normalized progress `et`. */
export function replyFrame(emote: ReplyEmote, et: number): ReplyFrame {
  switch (emote) {
    case "nod": {
      const n = nodBeat(et);
      return {
        ...REST,
        // Tip the top toward the viewer and dip: a nod, in 3D.
        pitch: -0.5 * n,
        ty: 0.045 * n,
        sx: 1 + 0.02 * n,
        sy: 1 - 0.04 * n,
        // Eyes on the captain - who types below the character - and they
        // drop a little further on each beat, so the face leads the nod.
        gaze: { x: 0, y: 0.25 + 0.55 * n },
        happy: band(et, 0.1, 0.08, 0.68, 0.1),
        glow: pulse(et, 0.05, 0.3) * 0.8,
      };
    }
    case "salute": {
      const wind = saluteWind(et);
      const tall = pulse(et, 0.2, 0.36);
      return {
        ...REST,
        // Wind up (squash, a small counter-turn), then snap and stand tall.
        spin: -0.2 * wind + (Math.PI / 2) * saluteSnap(et),
        pitch: 0.16 * tall,
        ty: 0.012 * wind - 0.03 * tall,
        sx: 1 + 0.045 * wind - 0.02 * tall,
        sy: 1 - 0.06 * wind + 0.05 * tall,
        gaze: { x: 0, y: 0.1 - 0.3 * tall },
        pointer: false,
        // Narrowed and determined through the wind-up, wide once it lands.
        lid: 0.5 * band(et, 0.02, 0.08, 0.36, 0.1),
        suppressBlink: true,
        glow: tall,
      };
    }
    case "tick": {
      const pen = tickPen(et);
      const drawn = tickDrawn(et);
      const lean = band(et, 0.08, 0.14, 0.62, 0.2);
      const center = alongTick(0.55);
      const gaze =
        pen !== null ? lookAt(pen) : et < 0.66 && drawn > 0 ? lookAt(center) : { x: 0, y: 0.15 };
      return {
        ...REST,
        rot: 0.06 * lean,
        // One small affirming dip as the check completes.
        ty: 0.018 * pulse(et, 0.4, 0.2),
        gaze,
        pointer: false,
        happy: band(et, 0.47, 0.06, 0.84, 0.1),
        glow: pulse(et, 0.41, 0.2) * 0.9,
      };
    }
    case "tuck": {
      const dot = tuckDot(et);
      const gulp = pulse(et, 0.53, 0.22);
      return {
        ...REST,
        sx: 1 - 0.05 * gulp,
        sy: 1 - 0.05 * gulp,
        // Tip back a little to look up at the dot, then settle.
        pitch: 0.18 * band(et, 0.06, 0.14, 0.36, 0.18),
        // The eyes find the dot and follow it in (lookAt overshoots upward
        // on purpose: the eye offset range is small, so the look is emphatic).
        gaze: dot ? { x: lookAt(dot).x, y: Math.max(-1, dot.y * 1.1) } : { x: 0, y: 0.1 },
        pointer: false,
        // One slow, content blink once it is in.
        lid: pulse(et, 0.6, 0.26),
        suppressBlink: true,
        glow: gulp,
      };
    }
    case "aww": {
      const shy = band(et, 0.05, 0.15, 0.8, 0.18);
      const sway = Math.sin((et - 0.12) * TAU * 2.1) * 0.035 * band(et, 0.12, 0.12, 0.74, 0.16);
      return {
        ...REST,
        rot: -0.07 * shy + sway,
        ty: 0.012 * shy,
        sx: 1 - 0.045 * shy,
        sy: 1 - 0.045 * shy,
        // Bashful: down and away.
        gaze: { x: -0.55, y: 0.55 },
        pointer: false,
        happy: band(et, 0.06, 0.1, 0.84, 0.12),
        glow: shy * 0.6,
      };
    }
  }
}

export type ReplyGarnishEnv = {
  ctx: CanvasRenderingContext2D;
  emote: ReplyEmote;
  et: number;
  c: number;
  R: number;
  size: number;
  /** The glow color the garnishes share with the rest of the character. */
  col: [number, number, number];
  /** Where the eyes were drawn this frame, and their radius. */
  eyes: ReadonlyArray<{ x: number; y: number }>;
  eyeR: number;
  /** Maps a point through this frame's pose, like the wires. */
  pose: (x: number, y: number) => [number, number];
};

const rgba = (c: [number, number, number], a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a))})`;

/**
 * Line-art garnish over the finished frame - the check, the tucked dot and
 * its closing ring, the blush marks - painted after the eyes like every
 * other garnish, in the shared glow color.
 */
export function drawReplyGarnish(env: ReplyGarnishEnv): void {
  const { ctx, emote, et, c, R, size, col } = env;
  const px = size / 280;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (emote === "salute") {
    // Two motion arcs sweep with the snap, on opposite sides - the rev.
    const k = pulse(et, 0.18, 0.34);
    if (k > 0.01) {
      const sweep = saluteSnap(et);
      const [cx, cy] = env.pose(c, c);
      ctx.lineWidth = 1.4 * px;
      for (const base of [-2.2, 0.94]) {
        const a1 = base + sweep * 0.9;
        const len = 0.9 * k;
        // Taper: three sub-arcs, brightest at the leading end.
        for (let j = 0; j < 3; j++) {
          const from = a1 - (len * (j + 1)) / 3;
          const to = a1 - (len * j) / 3;
          ctx.strokeStyle = rgba(col, 0.8 * k * (1 - j * 0.3));
          ctx.beginPath();
          ctx.arc(cx, cy, R * 1.22, from, to);
          ctx.stroke();
        }
      }
    }
  } else if (emote === "tick") {
    const drawn = tickDrawn(et);
    const fade = 1 - clamp01((et - 0.64) / 0.22);
    const flash = pulse(et, 0.41, 0.2);
    if (drawn > 0 && fade > 0) {
      const { a, b, c: end, l1, total } = TICK_SEGMENTS;
      const toXY = (p: { x: number; y: number }): [number, number] => [c + p.x * R, c + p.y * R];
      const head = alongTick(drawn);
      const path = (): void => {
        ctx.beginPath();
        ctx.moveTo(...toXY(a));
        if (drawn * total > l1) {
          ctx.lineTo(...toXY(b));
          ctx.lineTo(...toXY(head));
        } else {
          ctx.lineTo(...toXY(head));
        }
      };
      // A soft underglow so the stroke reads as light, then the crisp line.
      ctx.strokeStyle = rgba(col, (0.16 + 0.22 * flash) * fade);
      ctx.lineWidth = 5.5 * px;
      path();
      ctx.stroke();
      ctx.strokeStyle = rgba(col, (0.85 + 0.15 * flash) * fade);
      ctx.lineWidth = 1.9 * px;
      path();
      ctx.stroke();
      if (flash > 0.02) {
        // Completion: a few short sparks off the check's far tip.
        const [ex, ey] = toXY(end);
        ctx.strokeStyle = rgba(col, 0.8 * flash);
        ctx.lineWidth = 1.2 * px;
        for (let i = 0; i < 5; i++) {
          const ang = -Math.PI * 0.95 + i * 0.42;
          const r0 = R * (0.08 + 0.1 * (1 - flash));
          const len = R * 0.07 * flash;
          ctx.beginPath();
          ctx.moveTo(ex + Math.cos(ang) * r0, ey + Math.sin(ang) * r0);
          ctx.lineTo(ex + Math.cos(ang) * (r0 + len), ey + Math.sin(ang) * (r0 + len));
          ctx.stroke();
        }
      }
    }
    const pen = tickPen(et);
    if (pen) {
      // The pen is a loose dot, like the orbit fidget's, with a short trail.
      const [x, y] = [c + pen.x * R, c + pen.y * R];
      const out = clamp01((et - 0.06) / 0.04);
      ctx.fillStyle = rgba(col, 0.95 * out);
      ctx.beginPath();
      ctx.arc(x, y, 2.4 * px, 0, TAU);
      ctx.fill();
    }
  } else if (emote === "tuck") {
    const dot = tuckDot(et);
    if (dot) {
      const [x, y] = env.pose(c + dot.x * R, c + dot.y * R);
      if (et >= TUCK_SWOOP.from) {
        for (let g = 1; g <= 2; g++) {
          const back = tuckDot(Math.max(TUCK_SWOOP.from, et - g * 0.025));
          if (!back) continue;
          const [bx, by] = env.pose(c + back.x * R, c + back.y * R);
          ctx.fillStyle = rgba(col, 0.5 - g * 0.18);
          ctx.beginPath();
          ctx.arc(bx, by, (2.4 - g * 0.5) * back.r * px, 0, TAU);
          ctx.fill();
        }
      }
      // The kept thing is a small light, so it carries a soft halo like the
      // eyes do; the core is a dot like every loose dot.
      const hr = 9 * dot.r * px;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, hr);
      halo.addColorStop(0, rgba(col, 0.45 * dot.alpha));
      halo.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, hr, 0, TAU);
      ctx.fill();
      ctx.fillStyle = rgba(col, 0.95 * dot.alpha);
      ctx.beginPath();
      ctx.arc(x, y, 3 * dot.r * px, 0, TAU);
      ctx.fill();
    }
    const ring = tuckRing(et);
    if (ring) {
      // The notice ring, reversed: it closes in on what was just kept.
      const [x, y] = env.pose(c + TUCK_HOME.x * R, c + TUCK_HOME.y * R);
      ctx.strokeStyle = rgba(col, 0.55 * ring.strength);
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, R * (1.15 - 0.95 * ring.spread)), 0, TAU);
      ctx.stroke();
    }
  } else if (emote === "aww") {
    const k = band(et, 0.12, 0.1, 0.78, 0.14);
    if (k > 0.01) {
      // Blush, in line-art: three short slanted strokes under each eye.
      ctx.strokeStyle = rgba(col, 0.75 * k);
      ctx.lineWidth = 1.3 * px;
      const r = env.eyeR * 1.2;
      for (const e of env.eyes) {
        const side = e.x < c ? -1 : 1;
        const bx = e.x + side * r * 0.9;
        const by = e.y + r * 2.1;
        for (let i = -1; i <= 1; i++) {
          const x0 = bx + i * r * 0.85;
          ctx.beginPath();
          ctx.moveTo(x0 - r * 0.28, by + r * 0.42);
          ctx.lineTo(x0 + r * 0.28, by - r * 0.42);
          ctx.stroke();
        }
      }
    }
  }
  ctx.restore();
}
