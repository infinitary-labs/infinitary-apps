import { algolDim, algolEye, drawAlgolUnder } from "./algol";
import {
  type BhLayout,
  bhEnvelope,
  blackholeEye,
  drawBlackholeOver,
  drawBlackholeUnder,
  placeBlackholeVertices,
} from "./blackhole";
import {
  CinchClock,
  cinchBody,
  cinchMotes,
  cinchStill,
  drawCinchOver,
  drawCinchUnder,
} from "./cinch";
import {
  BIG_DIPPER,
  type Constellation,
  drawConstellationOver,
  ORION,
  placeConstellationVertices,
} from "./constellations";
import { receiveFrame, sendoffFrame } from "./crew/cues";
import {
  bankedHeat,
  CR,
  type CrLayout,
  crystalColors,
  crystalEdges,
  drawCrystalUnder,
  placeCrystalVertices,
} from "./crystal";
import {
  Blinker,
  band,
  clamp01,
  DEFAULT_POINTER_GAZE,
  easeInOut,
  easeOut,
  GAZE_REST_HZ,
  Gaze,
  noise1,
  PointerGaze,
  type PointerGazeOptions,
  pulse,
  TAU,
} from "./face";
import { FLICKER_TUNING, filamentWaver, flickerEnvelope } from "./flicker";
import { drawGalaxyUnder, GALAXY, placeGalaxyVertices } from "./galaxy";
import {
  compositeNeonHalo,
  ensureGlowBuffers,
  FM_GLOW_SPLIT,
  firstmateGlowBlurPx,
  type GlowBuffers,
  warmNeonHalo,
} from "./glow";
import type { FidgetVariant, FirstmateState, MachineSnapshot } from "./machine";
import { noticeFrame } from "./notice";
import { prefersReducedMotion } from "./reducedMotion";
import { drawReplyGarnish, isReplyEmote, type ReplyFrame, replyFrame } from "./replies";
import { drawSaturnOver, drawSaturnUnder, placeSaturnVertices, type SaturnLayout } from "./saturn";
import { type SkyDots, skyEnvelope } from "./sky";
import { stageNow } from "./stageClock";
import { FM_STATES, type StateTargets } from "./targets";
import {
  drawWarpSphere,
  isWarp,
  placeSphereVertices,
  type WarpVariant,
  warpJitter,
  warpPose,
} from "./warp";

// The Firstmate: a 4D tesseract projection of lines and dots with a pair of
// soft-light eyes in the inner cell - the captain-approved character design
// (spec and review record: firstmate/data/fm3000-character-animation-
// prototypes-s1/report.md). An explicit state machine (./machine) drives it:
// idle = near-still drift with wandering gaze and occasional fidgets;
// listening = the shapeshift flat into two counter-rotating hexagons (the
// inner square's vertices sink away - captain's call) breathing with the
// voice, spun faster by keystroke kicks; working = fast double rotation +
// shimmer with wires heated to ember. Heat rides the machine's busy
// parameter rather than the state, so listening or an emote mid-turn runs
// hot and cools in place when the turn ends. One-shot emotes (greet, celebrate, ponder,
// confused, and a fidget pool: roll, yawn, orbit, the five sky fidgets of
// ./sky - Orion, the Big Dipper, Saturn, a spiral galaxy, Algol - and a
// pretend black hole, which also sends the crew racing round their orbits,
// ./crew/rush, and the three warps of ./warp, which take the crew along,
// ./crew/warp) overlay the base states and return home on their own, and so
// do the reply emotes (./replies: nod, salute, tick, tuck, aww), which play
// as the Firstmate's own turn ends. A preserved crystal parameter folds the
// working character into the crystal (./crystal), and folding draws a ring
// tight round it while the first mate shortens its conversation (./cinch);
// like busy neither changes the state, so the canvas's aria-label stays the
// state name.
//
// The composited halo (./glow) is unchanged: every glow-contributing
// primitive resolves into shared scratch buffers replayed into one blurred
// mask and the crisp pass, so emote poses baked into the projected points
// stay consistent across both.
//
// The eyes follow the pointer (./face PointerGaze): wherever it moves in the
// window, the gaze is drawn toward it, bounded to the same small offset the
// wander already uses, on the same spring. A pointer that rests loses the
// eyes' interest after a moment and the state's own look (or the wander)
// takes over again; one that leaves the window lets go on the same ease.
// Choreographed emote looks (ponder, confused, the orbit / yawn / sky / black
// hole fidgets) keep their gaze under the default priority. Reduced motion is
// honored by the loop itself: it draws one static frame, so nothing tracks.
// A theme switch or a new pixel ratio (a size change, another display) draws
// that frame again from the same inputs, in the new theme's colors or at the
// new sharpness.
//
// Time is the stage clock's (./stageClock): every structure turns, breathes,
// flickers and emotes on stage time, so the character slows and pauses with
// its crew. The eyes alone stay on real time - they keep blinking and
// following the pointer through a complete pause (captain, FI3-398), which is
// what tells a paused stage from a stopped app.

export type PointerGazeConfig = Partial<PointerGazeOptions> & {
  /**
   * Which looks the pointer may override. "natural" leaves the choreographed
   * emote looks alone; "always" lets the pointer win everywhere.
   */
  priority?: "natural" | "always";
  /**
   * How far the eye's bright core leads its light along the gaze, as a
   * fraction of the gaze offset (0 keeps the core centered - the pre-pointer
   * drawing).
   */
  pupilShift?: number;
};

export type PointerSetup = {
  enabled: boolean;
  priority: "natural" | "always";
  pupilShift: number;
  options: Partial<PointerGazeOptions>;
};

const DEFAULT_PUPIL_SHIFT = 0.5;

export function resolvePointerSetup(followPointer: boolean | PointerGazeConfig): PointerSetup {
  if (followPointer === false) {
    return { enabled: false, priority: "natural", pupilShift: 0, options: {} };
  }
  if (followPointer === true) {
    return { enabled: true, priority: "natural", pupilShift: DEFAULT_PUPIL_SHIFT, options: {} };
  }
  const { priority = "natural", pupilShift = DEFAULT_PUPIL_SHIFT, ...options } = followPointer;
  return { enabled: true, priority, pupilShift, options };
}

/**
 * Whether the pointer may direct the gaze in this state. The base states and
 * the open-eyed emotes are attentive - the eyes glance at whatever moves;
 * the choreographed looks (ponder's upward drift, confusion's jitter, the
 * orbit / yawn / sky / black hole fidgets) are the character's own business.
 */
function pointerMayDirect(
  state: FirstmateState,
  fv: FidgetVariant | null,
  priority: "natural" | "always",
  reply: ReplyFrame | null,
): boolean {
  if (priority === "always") return true;
  if (state === "ponder" || state === "confused") return false;
  if (reply) return reply.pointer;
  if (state === "fidget") return fv === "roll";
  return true;
}

/**
 * What crystalActive asks of the working targets, blended in by the crystal
 * amount: the double rotation stills, the nodes calm, the eyes open a little.
 */
const CRYSTAL_TARGETS: Partial<StateTargets> = {
  sa: 0.02,
  sb: 0.02,
  pulse: 0.15,
  shimmer: 0,
  lidBase: 0.12,
  eyeScale: 1.05,
};

type Rgb = [number, number, number];

function fmRgba(color: string, alpha: number): string {
  const c = color.trim();
  if (c[0] === "#") {
    const n = Number.parseInt(c.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  if (c.indexOf("rgb(") === 0) return c.replace("rgb(", "rgba(").replace(")", `,${alpha})`);
  return c;
}

function fmRgb(color: string): Rgb {
  const c = color.trim();
  if (c[0] === "#") {
    const n = Number.parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [127, 220, 255];
}

function fmMix(a: Rgb, b: Rgb, t: number): string {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

function fmMixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function fmRgbaOf(c: Rgb, alpha: number): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
}

function tesseract(): { v: number[][]; e: [number, number][] } {
  const v: number[][] = [];
  for (let i = 0; i < 16; i++)
    v.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
  const e: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      let d = 0;
      for (let k = 0; k < 4; k++) if (v[i]?.[k] !== v[j]?.[k]) d++;
      if (d === 1) e.push([i, j]);
    }
  }
  return { v, e };
}

const { v: FM_V, e: FM_E } = tesseract();
// Listening form (TARS-style shapeshift): the vertices reassemble into two
// concentric counter-rotating hexagons - true cycles of the tesseract graph,
// so the wires glide into rings. The third cycle (an inner square in the
// original design) no longer forms: its four vertices sink to the center and
// fade, leaving the plane behind the eyes clear (captain's call).
const FM_RINGS = [
  [0, 1, 5, 4, 12, 8],
  [9, 11, 10, 14, 15, 13],
  [2, 3, 7, 6],
];
type FlatSlot = { ri: number; k: number; n: number };
const FM_FLAT: FlatSlot[] = new Array(16);
FM_RINGS.forEach((cyc, ri) => {
  cyc.forEach((vertex, k) => {
    FM_FLAT[vertex] = { ri, k, n: cyc.length };
  });
});
// Radius + spin direction per surviving ring (counter-rotating).
const FM_RING_R = [1, 0.62];
const FM_RING_DIR = [1, -1];
const FM_RINGEDGE = FM_E.map(([p, q]) => {
  const a = FM_FLAT[p] as FlatSlot;
  const b = FM_FLAT[q] as FlatSlot;
  return a.ri === b.ri && a.ri < 2 && ((a.k + 1) % a.n === b.k || (b.k + 1) % b.n === a.k);
});

// Black-hole spiral slots follow the same ring cycles (square innermost,
// then the hexagons), so consecutive slots are graph neighbors and the wires
// wind into the disc as connected chains instead of crisscrossing. The
// emote's geometry lives in ./blackhole and reads this layout.
const BH_RANK = new Array<number>(16);
FM_RINGS[2]?.forEach((v, k) => {
  BH_RANK[v] = k;
});
FM_RINGS[1]?.forEach((v, k) => {
  BH_RANK[v] = 4 + k;
});
FM_RINGS[0]?.forEach((v, k) => {
  BH_RANK[v] = 10 + k;
});
const BH_LAYOUT: BhLayout = {
  rank: BH_RANK,
  order: [...Array(16).keys()].sort((a, b) => (BH_RANK[a] ?? 0) - (BH_RANK[b] ?? 0)),
};

// The crystal (./crystal) lifts the listening form's rings into a standing
// bipyramid: the outer hexagon is its equator, the inner one its twisted
// inner ring, and the retired square gives two apexes and two sinking
// vertices.
const CR_LAYOUT: CrLayout = {
  equator: FM_RINGS[0] as number[],
  inner: FM_RINGS[1] as number[],
  apexes: [FM_RINGS[2]?.[0] as number, FM_RINGS[2]?.[1] as number],
  sinks: (FM_RINGS[2] as number[]).slice(2),
};
const CR_EDGES = crystalEdges(CR_LAYOUT);

// Saturn (./saturn) reads the listening rings too: the outer hexagon is the
// A ring, the inner one the B ring, the retired square the globe's belt.
const SAT_LAYOUT: SaturnLayout = {
  outer: FM_RINGS[0] as number[],
  inner: FM_RINGS[1] as number[],
  belt: FM_RINGS[2] as number[],
};

/** Projected vertex: screen x, screen y, depth scale, 4D w. */
type Pt = [number, number, number, number];

// Every primitive is resolved once per frame into these scratch buffers, then
// replayed twice: into the glow mask and into the crisp geometry. Sharing the
// numbers is what guarantees the halo can never drift from the wires it
// belongs to. drawFrame is synchronous, so one set serves every instance.
const edgeSkip = new Uint8Array(FM_E.length);
const edgeAlpha = new Float64Array(FM_E.length);
const edgeMix = new Float64Array(FM_E.length);
const edgeCore = new Uint8Array(FM_E.length);
const edgeCoreAlpha = new Float64Array(FM_E.length);
const dotAlpha = new Float64Array(FM_V.length);
const dotMix = new Float64Array(FM_V.length);
const dotR = new Float64Array(FM_V.length);
const dotCore = new Uint8Array(FM_V.length);
const dotCoreAlpha = new Float64Array(FM_V.length);
// How far each vertex has wound into the black hole's disc or settled on a
// sky figure; the black hole's placer fills it (zeros when it is not
// playing) and the sky placers write it when theirs is.
const windProgress = new Float64Array(16);
// The sky fidgets' restyle of the dots (./sky SkyDots), reset every frame.
const skyDots: SkyDots = {
  scale: new Float64Array(16),
  fade: new Float64Array(16),
  white: new Float64Array(16),
};
// The crystal restyle: how far each primitive mixes toward the cool light,
// and how much of it the halo mask takes (1 everywhere outside a crystal).
const edgeCool = new Float64Array(FM_E.length);
const edgeHalo = new Float64Array(FM_E.length);
const dotCool = new Float64Array(FM_V.length);
const dotHalo = new Float64Array(FM_V.length);
// The token flicker's halo shares for the white-hot cores: the fraction of
// a core the mask takes, so the flicker-lit part stays out of the glow
// (1 whenever no flicker plays; ./flicker).
const edgeCoreHalo = new Float64Array(FM_E.length);
const dotCoreHalo = new Float64Array(FM_V.length);
const crDepth = new Float64Array(16);

export type Sim = {
  size: number;
  accent: string;
  dim: string;
  hot: string;
  bg: string;
  accRgb: Rgb;
  dimRgb: Rgb;
  hotRgb: Rgb;
  bgRgb: Rgb;
  boost: number;
  /** `--halo-boost`: the halo lifted so it reads over the translucent window. */
  haloBoost: number;
  lastRead: number;
  a: number;
  b: number;
  hs: number;
  vel: number;
  lastKick: number;
  last: number;
  /** The last frame's real time: the eyes' own clock. */
  lastReal: number;
  cur: StateTargets;
  /** Busy-driven ember, blended separately from the state targets. */
  heat: number;
  blink: Blinker;
  gaze: Gaze;
  lid: number;
  wink: number;
  happy: number;
  eye: { x: number; y: number };
  pointer: PointerGaze;
  /** Offscreens for the composited halo; allocated the first time it glows. */
  glow: GlowBuffers | null;
  /** When the last "new card" notice pulse started (./notice). */
  noticeAt: number;
  /** When the last crew send-off cue started, and where it looked (./crew/cues). */
  sendoffAt: number;
  sendoffDir: { dx: number; dy: number };
  sendoffStrength: number;
  /** When the last receive cue (a report or a crewmate coming home) started. */
  receiveAt: number;
  /** Eased crystal amount: toward 1 while crystalActive in the working state. */
  crystal: number;
  /** The crystalActive input as last seen, for its edges. */
  crystalRaw: boolean;
  /** When the current crystal began (the climbing band's cadence). */
  crystalAt: number;
  /** When the last crystal ended (the answer's descending band). */
  answerAt: number;
  /** When the last token flicker began, and its strength (usage-mapped). */
  flickerAt: number;
  flickerBoost: number;
  /** The cinch's own clock (./cinch), and how far the working state lets it show. */
  cinch: CinchClock;
  cinchGate: number;
};

export function createSim(
  size: number,
  canvas: HTMLCanvasElement,
  kick: number,
  foldStarts: number,
): Sim {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  return {
    size,
    accent: "",
    dim: "",
    hot: "",
    bg: "",
    accRgb: [127, 220, 255],
    dimRgb: [93, 104, 132],
    hotRgb: [255, 162, 87],
    bgRgb: [5, 7, 13],
    boost: 1,
    haloBoost: 1,
    lastRead: 0,
    a: 0.4,
    b: 0.9,
    hs: 0,
    vel: 0.5,
    lastKick: kick,
    last: stageNow(),
    lastReal: performance.now(),
    cur: { ...(FM_STATES.idle as StateTargets) },
    heat: 0,
    blink: new Blinker(),
    gaze: new Gaze(),
    lid: 0,
    wink: 0,
    happy: 0,
    eye: { x: 0, y: 0 },
    pointer: new PointerGaze(),
    glow: null,
    noticeAt: Number.NEGATIVE_INFINITY,
    sendoffAt: Number.NEGATIVE_INFINITY,
    sendoffDir: { dx: 1, dy: 0 },
    sendoffStrength: 1,
    receiveAt: Number.NEGATIVE_INFINITY,
    crystal: 0,
    crystalRaw: false,
    crystalAt: Number.NEGATIVE_INFINITY,
    answerAt: Number.NEGATIVE_INFINITY,
    flickerAt: Number.NEGATIVE_INFINITY,
    flickerBoost: 0,
    cinch: new CinchClock(foldStarts),
    cinchGate: 0,
  };
}

/**
 * Replay the resolved primitives - edges, their filament cores, dots, their
 * incandescent cores - into a context.
 *
 * With `colors`, this is the crisp geometry pass. With `colors` null the
 * caller has already set one flat tint on the context, which is the glow mask
 * pass; `alphaScale` is then 1/FM_GLOW_SPLIT so the additive accumulation
 * stays under 1.0. Both passes walk the same numbers in the same order.
 */
function paintPrimitives(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  colors: { dim: Rgb; bright: Rgb; cool: Rgb; coolCore: Rgb } | null,
  alphaScale: number,
): void {
  // The mask pass weighs each primitive by its halo share; the crisp pass
  // paints every primitive at full strength.
  const mask = colors === null;
  ctx.lineWidth = 1.4;
  for (let i = 0; i < FM_E.length; i++) {
    if (edgeSkip[i]) continue;
    const [p, q] = FM_E[i] as [number, number];
    const P = pts[p] as Pt;
    const Q = pts[q] as Pt;
    const cool = edgeCool[i] as number;
    if (colors) {
      ctx.strokeStyle = fmMix(
        fmMixRgb(colors.dim, colors.bright, edgeMix[i] as number),
        colors.cool,
        cool,
      );
    }
    const haloShare = mask ? (edgeHalo[i] as number) : 1;
    if (haloShare <= 0.01) continue;
    ctx.globalAlpha = (edgeAlpha[i] as number) * alphaScale * haloShare;
    ctx.beginPath();
    ctx.moveTo(P[0], P[1]);
    ctx.lineTo(Q[0], Q[1]);
    ctx.stroke();
    if (edgeCore[i]) {
      // White-hot filament core on the bright edges; the mask pass takes its
      // own share so a flicker never reaches the halo through it.
      const coreShare = mask ? (edgeCoreHalo[i] as number) : 1;
      ctx.globalAlpha = (edgeCoreAlpha[i] as number) * alphaScale * coreShare;
      if (colors) {
        ctx.strokeStyle = fmMix(
          fmMixRgb(colors.bright, [255, 244, 224], 0.75),
          colors.coolCore,
          cool,
        );
      }
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(P[0], P[1]);
      ctx.lineTo(Q[0], Q[1]);
      ctx.stroke();
      ctx.lineWidth = 1.4;
    }
  }
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i] as Pt;
    const r = dotR[i] as number;
    const haloShare = mask ? (dotHalo[i] as number) : 1;
    if ((dotAlpha[i] as number) * haloShare <= 0.01) continue;
    const cool = dotCool[i] as number;
    ctx.globalAlpha = (dotAlpha[i] as number) * alphaScale * haloShare;
    // Keep far-side dots from dimming into bright foreground lines.
    if (colors) {
      ctx.fillStyle = fmMix(
        fmMixRgb(colors.dim, colors.bright, Math.max(dotMix[i] as number, 0.35)),
        colors.cool,
        cool,
      );
    }
    ctx.beginPath();
    ctx.arc(P[0], P[1], r, 0, Math.PI * 2);
    ctx.fill();
    if (dotCore[i]) {
      // Incandescent dot cores; the mask pass also divides a flicker's
      // share back out, so it never reaches the halo through them.
      const coreShare = mask ? haloShare * (dotCoreHalo[i] as number) : 1;
      ctx.globalAlpha = (dotCoreAlpha[i] as number) * alphaScale * coreShare;
      if (colors) {
        ctx.fillStyle = fmMix(fmMixRgb(colors.bright, [255, 248, 235], 0.8), colors.coolCore, cool);
      }
      ctx.beginPath();
      ctx.arc(P[0], P[1], r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Celebration ticks: short line sparks radiating outward, line-art only. */
function drawSparkles(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  t: number,
  radius: number,
  col: Rgb,
): void {
  if (t <= 0 || t >= 1) return;
  const grow = easeOut(t);
  const fade = 1 - t * t;
  ctx.save();
  ctx.strokeStyle = fmRgbaOf(col, 0.85 * fade);
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + 1.7 + (i % 2) * 0.2;
    const r0 = radius * (0.55 + 0.45 * grow);
    const len = radius * 0.1 * (1 - t * 0.6) * (0.7 + 0.3 * Math.sin(i * 2.7));
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    ctx.stroke();
  }
  ctx.restore();
}

export function drawFrame(
  sim: Sim,
  canvas: HTMLCanvasElement,
  now: number,
  real: number,
  snap: MachineSnapshot,
  level: number,
  kick: number,
  pointerSetup: PointerSetup,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const size = sim.size;
  if (!sim.glow) {
    // First frame: pay the halo pipeline's one-time costs (offscreen
    // allocation, Skia blur warmup) while the character is still idle, so the
    // first idle -> working morph is as smooth as every later one. The token
    // paint lands before this frame's clearRect below, so it never shows.
    sim.glow = ensureGlowBuffers(null, canvas.width, canvas.height);
    warmNeonHalo(ctx, sim.glow, dpr, firstmateGlowBlurPx(1, size, dpr));
  }
  if (sim.lastRead === 0 || real - sim.lastRead > 400) {
    // Re-read theme colors so a live theme switch re-paints the character.
    const cs = getComputedStyle(canvas);
    sim.accent = (
      cs.getPropertyValue("--wire-accent") ||
      cs.getPropertyValue("--accent") ||
      sim.accent
    ).trim();
    sim.dim = (
      cs.getPropertyValue("--wire-dim") ||
      cs.getPropertyValue("--fg-3") ||
      sim.dim
    ).trim();
    sim.hot = (cs.getPropertyValue("--wire-hot") || sim.hot).trim();
    sim.bg = (cs.getPropertyValue("--bg-0") || sim.bg).trim();
    sim.boost = Number.parseFloat(cs.getPropertyValue("--wire-boost")) || 1;
    sim.haloBoost = Number.parseFloat(cs.getPropertyValue("--halo-boost")) || 1;
    sim.accRgb = fmRgb(sim.accent);
    sim.dimRgb = fmRgb(sim.dim);
    sim.hotRgb = fmRgb(sim.hot);
    sim.bgRgb = fmRgb(sim.bg || "#05070d");
    sim.lastRead = real;
  }
  const dt = Math.min((now - sim.last) / 1000, 0.05);
  sim.last = now;
  const eyeDt = Math.min(Math.max(0, real - sim.lastReal) / 1000, 0.05);
  sim.lastReal = real;
  const tSec = now / 1000;
  const state = snap.state;
  const et = snap.emoteT;
  const fv: FidgetVariant | null = state === "fidget" ? (snap.variant ?? "roll") : null;
  const reply: ReplyFrame | null = isReplyEmote(state) ? replyFrame(state, et) : null;
  // The sky fidgets (./sky): one envelope, the variant picking the figure.
  const skyK =
    fv === "orion" || fv === "dipper" || fv === "saturn" || fv === "galaxy" || fv === "algol"
      ? skyEnvelope(et)
      : 0;
  const con: Constellation | null = fv === "orion" ? ORION : fv === "dipper" ? BIG_DIPPER : null;
  // The warps (./warp): the first mate's own carriage through the wormhole.
  const warpV: WarpVariant | null = isWarp(fv) ? fv : null;
  const wp = warpV ? warpPose(warpV, et) : null;
  const sat = fv === "saturn" ? skyK : 0;
  const gal = fv === "galaxy" ? skyK : 0;
  const alg = fv === "algol" ? skyK : 0;
  // Algol's eclipse dims the whole character's light (./algol).
  const dim = alg > 0.001 ? algolDim(alg, et) : 1;
  const t = FM_STATES[state] ?? (FM_STATES.idle as StateTargets);
  // Crystal activation is a parameter over working: it eases in only while the
  // character is working, so attention and emotes unfold the crystal and it
  // refolds when they end with the crystal still running. Its edges stamp
  // the climbing band's cadence and the answer. A reduced-motion still
  // snaps to the pose rather than catching the first frame of the ease.
  const reduced = prefersReducedMotion();
  const crystalTarget = snap.crystalActive && state === "working" ? 1 : 0;
  sim.crystal = reduced
    ? crystalTarget
    : sim.crystal + (crystalTarget - sim.crystal) * Math.min(dt * 3, 1);
  if (snap.crystalActive !== sim.crystalRaw) {
    sim.crystalRaw = snap.crystalActive;
    if (snap.crystalActive) sim.crystalAt = now;
    else sim.answerAt = now;
  }
  const ck = sim.crystal;
  const cur = sim.cur;
  for (const k of Object.keys(cur) as (keyof StateTargets)[]) {
    const target = t[k] + ((CRYSTAL_TARGETS[k] ?? t[k]) - t[k]) * ck;
    // Ease between states - the shapeshift is this same continuous blend.
    cur[k] += (target - cur[k]) * Math.min(dt * 4, 1);
  }
  // The ember rides the machine's busy parameter, easing so a turn ending
  // mid-listening cools the character in place without a state change.
  sim.heat += ((snap.busy ? 1 : 0) - sim.heat) * Math.min(dt * 3, 1);
  // The cinch (./cinch) is a parameter over working like the crystal:
  // attention and emotes ease it out, and it comes back while the
  // shortening still runs. A reduced-motion still stands in the tight pose.
  const cinchF = reduced ? cinchStill(snap.folding) : sim.cinch.frame(now);
  const cinchTarget = state === "working" ? 1 : 0;
  sim.cinchGate = reduced
    ? cinchTarget
    : sim.cinchGate + (cinchTarget - sim.cinchGate) * Math.min(dt * 3, 1);
  const cinchK = cinchF ? cinchF.k * sim.cinchGate : 0;
  const cinchB = cinchBody(cinchK);
  const cinchKz = clamp01(cinchK);
  const cinchLift = cinchF ? cinchF.lift * sim.cinchGate : 0;
  const cinchFlight = cinchF && !reduced ? cinchMotes(cinchF) : { motes: [], arrival: 0 };
  // The token flicker (./flicker): a completed request's usage lands as a
  // brightness wave on the wires - fast rise, damped waver, gone. It never
  // changes the state, and a reduced-motion still never catches one.
  const flick = reduced ? 0 : sim.flickerBoost * flickerEnvelope(now - sim.flickerAt);
  // Everything the flicker may lift that ISN'T a wire runs through `spill`,
  // so the halo, ambient wash and eye light take only a whisper of it.
  const spill = flick * FLICKER_TUNING.glowSpill;

  // Listening spin: default velocity, accelerated by voice level and
  // keystroke kicks, decaying smoothly back.
  if (kick !== sim.lastKick) {
    sim.vel = Math.min(sim.vel + (kick - sim.lastKick) * 1.4, 30);
    sim.lastKick = kick;
  }
  sim.vel += (0.5 + (level || 0) * 6 - sim.vel) * Math.min(dt * 1.5, 1);
  sim.a += (cur.sa * cinchB.spin + (wp?.sa ?? 0)) * dt;
  sim.b += (cur.sb * cinchB.spin + (wp?.sb ?? 0)) * dt;
  sim.hs += dt * sim.vel * cur.flat;

  if (state === "listening") sim.gaze.look(0, 0);
  else if (state === "working")
    sim.gaze.look(cinchB.look[0] * (1 - ck), cinchB.look[1] - 0.75 * ck);
  else if (state === "ponder") sim.gaze.look(-0.8, -0.9);
  else if (state === "confused") sim.gaze.look(noise1(tSec * 6) * 0.8, noise1(tSec * 5 + 9) * 0.5);
  else if (state === "fidget") {
    if (fv === "orbit") {
      // The eyes follow the loose dot around.
      const ang = -Math.PI / 2 + easeInOut(clamp01((et - 0.1) / 0.75)) * TAU;
      sim.gaze.look(Math.cos(ang) * 0.9, Math.sin(ang) * 0.7);
    } else if (fv === "yawn") sim.gaze.look(0, -0.35 * pulse(et, 0.12, 0.62));
    else if (fv === "blackhole")
      sim.gaze.look(0, 0.12); // concentrating
    else if (con) sim.gaze.look(con.gaze[0], con.gaze[1]);
    else if (fv === "saturn") sim.gaze.look(0, 0.1);
    else if (wp) sim.gaze.look(wp.look[0], wp.look[1]);
    else sim.gaze.look(0, 0);
  } else if (reply?.gaze) sim.gaze.look(reply.gaze.x, reply.gaze.y);
  else sim.gaze.free();
  // The pointer's pull rides over whatever the state decided, by its
  // attention weight; the spring quickens while it holds the eyes.
  sim.pointer.configure(pointerSetup.options);
  const pull = sim.pointer.update(eyeDt);
  const pullW =
    pointerSetup.enabled && pointerMayDirect(state, fv, pointerSetup.priority, reply)
      ? pull.weight
      : 0;
  // A crew send-off: for its moment the character looks where it sent
  // someone, over the pointer's pull (./crew/cues).
  const sendoff = sendoffFrame(now - sim.sendoffAt, sim.sendoffStrength);
  if (sendoff.look > pullW) {
    sim.gaze.attract(sim.sendoffDir.dx * 0.9, sim.sendoffDir.dy * 0.8, sendoff.look);
  } else {
    sim.gaze.attract(pull.x, pull.y, pullW);
  }
  const trackHz = pointerSetup.options.trackHz ?? DEFAULT_POINTER_GAZE.trackHz;
  sim.gaze.setResponse(GAZE_REST_HZ + (trackHz - GAZE_REST_HZ) * Math.max(pullW, sendoff.look));
  sim.eye = sim.gaze.update(eyeDt);

  sim.lid = Math.max(
    cur.lidBase,
    sim.blink.update(
      eyeDt,
      state === "listening" || state === "celebrate" || (reply?.suppressBlink ?? false),
    ),
  );
  if (reply) sim.lid = Math.max(sim.lid, reply.lid);
  // The cinch narrows the eyes, and its end gives one slow blink.
  sim.lid = Math.max(sim.lid, cinchB.lid);
  if (cinchF?.phase === "out")
    sim.lid = Math.max(sim.lid, pulse(cinchF.u, 0.1, 0.65) * sim.cinchGate);
  // Variant lids: the roll closes its eyes through the turn; the yawn droops
  // them with the stretch; the black hole squints with effort.
  if (fv === "roll") sim.lid = Math.max(sim.lid, band(et, 0.3, 0.15, 0.6, 0.22));
  if (fv === "yawn") sim.lid = Math.max(sim.lid, pulse(et, 0.12, 0.62) * 0.95);
  if (fv === "blackhole") sim.lid = Math.max(sim.lid, bhEnvelope(et) * 0.3);
  if (fv === "galaxy") sim.lid = Math.max(sim.lid, gal * GALAXY.lid);
  if (wp) sim.lid = Math.max(sim.lid, wp.lid);
  sim.wink = state === "greet" ? band(et, 0.42, 0.1, 0.68, 0.12) : 0;
  sim.happy =
    state === "celebrate"
      ? band(et, 0.08, 0.15, 0.85, 0.15)
      : state === "greet"
        ? band(et, 0.12, 0.18, 0.82, 0.18)
        : (reply?.happy ?? 0);

  const c = size / 2;
  const { accRgb, dimRgb, hotRgb, bgRgb, boost } = sim;
  const heat = sim.heat;
  // A crystal banks the ember: the wires give it up for the cool light, the
  // eyes and cores keep half (./crystal bankedHeat).
  const { wire: heatWire, core: heatCore } = bankedHeat(heat, ck);
  const { cool: coolRgb, coolCore: coolCoreRgb } = crystalColors(accRgb);
  // Hot wires blend from ice cyan to ember, glow follows; the far side heats
  // too so both ends stay one family.
  const briRgb: Rgb = fmMixRgb(accRgb, hotRgb, heatWire);
  const dimRgbUse: Rgb = fmMixRgb(
    dimRgb,
    [hotRgb[0] * 0.55, hotRgb[1] * 0.5, hotRgb[2] * 0.45],
    heatWire,
  );
  const glowCol = fmMix(fmMixRgb(accRgb, hotRgb, heatWire), coolRgb, ck);
  const glowRgb: Rgb = fmMixRgb(fmMixRgb(accRgb, hotRgb, heatWire), coolRgb, ck);
  // Listening: slow deep breath + live voice level; other states stay steady.
  // A send-off adds one small exhale at the moment of emission.
  const breathe =
    (1 + cur.breath * Math.sin(now / 650) + (level || 0) * cur.breath * 1.6) *
    (1 + 0.035 * sendoff.exhale);
  const R0 = size * 0.27 * breathe * cur.scale * (wp?.scale ?? 1);
  // The cinch draws the body tight, and it springs back past its size.
  const R = R0 * cinchB.scale;

  // Emote choreography factors, baked into the projected points below so the
  // glow mask and crisp pass stay consistent by construction.
  const bh = fv === "blackhole" ? bhEnvelope(et) : 0;
  const rollExtra = fv === "roll" ? easeInOut(clamp01((et - 0.08) / 0.75)) * Math.PI : 0;
  let poseRot = 0;
  let poseTx = 0;
  let poseTy = 0;
  let poseSx = 1;
  let poseSy = 1;
  if (state === "greet") {
    const bow = Math.sin(Math.min(1, et / 0.55) * Math.PI) * 0.14;
    poseRot = bow * 0.5;
    poseTy = bow * size * 0.12;
  } else if (state === "ponder") {
    poseRot = -0.1 * Math.sin(Math.min(1, et * 1.4) * Math.PI);
  } else if (state === "confused") {
    poseRot = Math.sin(et * Math.PI * 3) * 0.08 * Math.sin(et * Math.PI);
  } else if (fv === "yawn") {
    const y = pulse(et, 0.12, 0.62);
    poseSy = 1 + 0.16 * y;
    poseSx = 1 - 0.09 * y;
  } else if (wp) {
    // The corkscrew leans into the wormhole and stretches with the speed.
    poseRot = wp.rot;
    poseSx = wp.sx;
    poseSy = wp.sy;
  } else if (reply) {
    poseRot = reply.rot;
    poseTx = reply.tx * size;
    poseTy = reply.ty * size;
    poseSx = reply.sx;
    poseSy = reply.sy;
  }
  const poseCos = Math.cos(poseRot);
  const poseSin = Math.sin(poseRot);
  const posePoint = (x: number, y: number): [number, number] => {
    const dx = (x - c) * poseSx;
    const dy = (y - c) * poseSy;
    return [c + poseTx + dx * poseCos - dy * poseSin, c + poseTy + dx * poseSin + dy * poseCos];
  };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  // A card landed on the stack unseen: the notice pulse lifts the glow and
  // sends one ring outward. It overlays every state and changes none.
  const notice = noticeFrame(now - sim.noticeAt);
  // A report or a crewmate coming home: one quick lift, no ring.
  const receive = receiveFrame(now - sim.receiveAt);
  // Ambient glow - pulses gently while listening.
  const glowA =
    dim *
    (sim.haloBoost *
      cur.glow *
      (wp?.glow ?? 1) *
      (0.1 + heat * 0.16 + cur.breath * 0.6 * (0.5 + 0.5 * Math.sin(now / 650))) +
      notice.strength * 0.3 +
      sendoff.glow * 0.22 +
      receive.glow * 0.2 +
      (reply?.glow ?? 0) * 0.18 +
      cinchKz * 0.08 * (0.4 + 0.6 * cinchFlight.arrival) +
      cinchLift * 0.3 +
      spill * 0.5);
  const g = ctx.createRadialGradient(c, c, 0, c, c, size / 2);
  g.addColorStop(0, fmRgba(glowCol, glowA));
  g.addColorStop(1, fmRgba(glowCol, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // Rotate xw and yz, project 4D -> 3D -> 2D. Confusion adds a stutter to the
  // xw spin and a positional jitter; the roll fidget adds one full inversion.
  const confSpin =
    state === "confused" ? Math.sin(et * Math.PI * 5) * 0.9 * Math.sin(et * Math.PI) * 0.2 : 0;
  const spin = rollExtra + confSpin + (reply?.spin ?? 0);
  const ca = Math.cos(sim.a + spin);
  const sa2 = Math.sin(sim.a + spin);
  // A reply's nod (and the tuck's look up) pitches the yz rotation.
  const cb = Math.cos(sim.b + (reply?.pitch ?? 0));
  const sb2 = Math.sin(sim.b + (reply?.pitch ?? 0));
  const jit = cur.jitter * Math.sin(et * Math.PI) * 0.09;
  const pts = FM_V.map(([x = 0, y = 0, z = 0, w = 0], i) => {
    const x1 = x * ca - w * sa2;
    const w1 = x * sa2 + w * ca;
    const y1 = y * cb - z * sb2;
    const z1 = y * sb2 + z * cb;
    const k4 = 2.6 / (2.6 - w1 * 0.55);
    const X = x1 * k4;
    const Y = y1 * k4;
    const Z = z1 * k4;
    const k3 = 3.4 / (3.4 - Z * 0.5);
    let px = c + X * k3 * R * 0.5;
    let py = c + Y * k3 * R * 0.5;
    if (jit > 0.001) {
      px += noise1(tSec * 14 + i * 3.1) * jit * R;
      py += noise1(tSec * 13 + i * 5.7) * jit * R;
    }
    if (wp && wp.jitter > 0.0005) {
      const [nx, ny] = warpJitter(tSec, i);
      px += nx * wp.jitter * R;
      py += ny * wp.jitter * R;
    }
    return [px, py, (k4 + k3) / 2, w1] as Pt;
  });

  // Morph toward the flat listening form: hexagon vertices lerp to their ring
  // slots; the retired inner square's four vertices sink to the center.
  const f = cur.flat * cur.flat * (3 - 2 * cur.flat);
  if (f > 0.001) {
    const rf = size * 0.4 * breathe;
    for (let i = 0; i < 16; i++) {
      const slot = FM_FLAT[i] as FlatSlot;
      const p = pts[i] as Pt;
      if (slot.ri === 2) {
        p[0] += (c - p[0]) * f;
        p[1] += (c - p[1]) * f;
        continue;
      }
      const ang =
        (FM_RING_DIR[slot.ri] as number) * sim.hs + (slot.k / slot.n) * Math.PI * 2 - Math.PI / 2;
      p[0] += (c + Math.cos(ang) * (FM_RING_R[slot.ri] as number) * rf - p[0]) * f;
      p[1] += (c + Math.sin(ang) * (FM_RING_R[slot.ri] as number) * rf - p[1]) * f;
    }
  }

  // Pretend black hole: the frame winds into the inclined, lensed accretion
  // disk one ring at a time (inner square first, hexagons wrapping after);
  // ./blackhole owns the geometry and reports each vertex's progress.
  placeBlackholeVertices(bh, BH_LAYOUT, pts, c, R, tSec, windProgress);

  // The sky fidgets: the vertices settle on a constellation's stars, onto
  // Saturn's rings, or out along a galaxy's arms (./constellations, ./saturn
  // and ./galaxy own the geometry and report each vertex's progress the
  // same way; Algol moves only the eyes, below).
  skyDots.scale.fill(1);
  skyDots.fade.fill(1);
  skyDots.white.fill(0);
  if (con) placeConstellationVertices(skyK, con, pts, c, R, tSec, windProgress, skyDots);
  placeSaturnVertices(sat, SAT_LAYOUT, pts, c, R, tSec, windProgress, skyDots);
  placeGalaxyVertices(gal, pts, c, R, tSec, windProgress, skyDots);
  // The sphere warp: the vertices take their places on the wormhole's rim (./warp).
  if (warpV === "sphere") placeSphereVertices(et, BH_LAYOUT.rank, pts, c, R, tSec, windProgress);

  // The crystal: the vertices lift into the standing bipyramid by the
  // crystal amount (./crystal owns the geometry).
  placeCrystalVertices(ck, CR_LAYOUT, pts, c, R, tSec, crDepth);

  // Emote pose (bow, tilt, yawn stretch), baked into the points.
  if (poseRot !== 0 || poseTx !== 0 || poseTy !== 0 || poseSx !== 1 || poseSy !== 1) {
    for (const p of pts) {
      const [px, py] = posePoint(p[0], p[1]);
      p[0] = px;
      p[1] = py;
    }
  }

  // Neon pass: hot wires cast a real glow and get a white-hot core.
  const neon = heatWire;
  // The tesseract's own wires fade out ahead of the crystal forming.
  const wireFade = 1 - clamp01(ck * 1.6);
  // Resolve every primitive once; the glow mask and the crisp geometry both
  // replay these.
  for (let i = 0; i < FM_E.length; i++) {
    const [p, q] = FM_E[i] as [number, number];
    const P = pts[p] as Pt;
    const Q = pts[q] as Pt;
    const depth = (P[2] + Q[2]) / 2 - 0.9;
    // A wire leaves the body only as both its ends wind into the disc or
    // settle on a sky figure; Algol's eclipse dims what is left.
    const bhDim = (1 - Math.min(windProgress[p] ?? 0, windProgress[q] ?? 0) * 0.97) * dim;
    let alpha = Math.max(0.3, Math.min(0.9, 0.35 + depth * 0.5)) * boost;
    if (cur.shimmer > 0) {
      // Gentle, low-frequency shimmer - fast alpha strobing flickers badly
      // under acrylic blur.
      alpha *= 1 - cur.shimmer * 0.3 * (0.5 + 0.5 * Math.sin(now / 240 + i * 2.7));
    }
    // In the flat form only hexagon ring edges remain; spokes and the whole
    // retired square fade out with the morph.
    if (!FM_RINGEDGE[i]) {
      alpha *= 1 - f;
      if (alpha * bhDim < 0.02) {
        edgeSkip[i] = 1;
        continue;
      }
    } else {
      alpha += (Math.min(1, 0.85 * boost) - alpha) * f;
    }
    alpha *= wireFade;
    // The cinch dims the outer cell and lifts every wire at its end.
    if (P[3] > 0 && Q[3] > 0) alpha *= cinchB.outer;
    alpha *= 1 + 0.5 * cinchLift;
    if (alpha < 0.02) {
      edgeSkip[i] = 1;
      continue;
    }
    edgeSkip[i] = 0;
    // Smooth inner/outer blend on w - no discrete pop as edges cross w=0.
    const m = Math.max(Math.max(0, Math.min(1, 0.5 + (P[3] + Q[3]) * 0.35)), f * 0.9);
    // Inside a token flicker each wire wavers on its own phase toward the
    // hot end of the palette, its white-hot core lit even while the rig
    // runs cool (./flicker `filamentWaver`). With no flicker `fw` is 0 and
    // every line below is the resting rig's own arithmetic.
    const fw = flick > 0 ? flick * filamentWaver(i, now) : 0;
    edgeMix[i] = Math.max(m, Math.min(1, fw * 0.8));
    edgeAlpha[i] = Math.min(1, alpha * (0.85 + 0.15 * m) * (1 + 0.85 * fw)) * bhDim;
    edgeCore[i] = (neon > 0.02 || fw > 0.08) && m > 0.5 ? 1 : 0;
    edgeCoreAlpha[i] = Math.min(1, alpha) * Math.max(neon, fw * 1.1) * 0.85 * bhDim;
    edgeCool[i] = ck;
    // The flicker is filament, not floodlight: the halo mask's shares divide
    // the waver back out, so the blurred under-glow stays at the rig's own
    // level while the crisp wires dance.
    edgeHalo[i] = 1 / (1 + 0.85 * fw);
    edgeCoreHalo[i] = fw > 0 ? neon / Math.max(neon, fw * 1.1) : 1;
  }
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i] as Pt;
    const slot = FM_FLAT[i] as FlatSlot;
    // The square's vertices vanish with the flat morph; every dot survives
    // the black hole (they orbit inside the disc).
    // The crystal's sinking vertices fade with it; its apexes carry cool
    // cores and the halo.
    const apex = i === CR_LAYOUT.apexes[0] || i === CR_LAYOUT.apexes[1];
    const sink = !apex && slot.ri === 2;
    const fade = (slot.ri === 2 ? 1 - f : 1) * (sink ? 1 - ck : 1);
    const pulseK = 1 + cur.pulse * 0.6 * Math.max(0, Math.sin(now / 300 + i * 0.8));
    const m = Math.max(Math.max(0, Math.min(1, 0.5 + P[3] * 0.6)), f);
    dotMix[i] = m;
    dotR[i] = (2.1 + 0.7 * m) * pulseK * (size / 280) * (skyDots.scale[i] as number);
    dotAlpha[i] =
      Math.min(1, Math.max(0.65, Math.min(1, 0.6 + (P[2] - 0.9) * 0.5)) * boost) *
      fade *
      (skyDots.fade[i] as number) *
      dim *
      (1 + 0.4 * cinchLift);
    // A token flicker lights the dot cores too, weaker than the wires.
    const cored = (heatCore > 0.02 || flick > 0.2) && m > 0.4 && fade > 0.5;
    const apexCore = apex ? ck : 0;
    dotCore[i] = cored || apexCore > 0.02 ? 1 : 0;
    dotCoreAlpha[i] = Math.max(cored ? Math.max(heatCore, flick * 0.5) * fade : 0, apexCore * fade);
    // Same bargain as the edges: the flicker-lit part of a core is
    // crisp-pass only, so the halo mask takes the resting core's share.
    const coreA = dotCoreAlpha[i] as number;
    if (flick > 0 && coreA > 0) {
      const calmCore = heatCore > 0.02 && m > 0.4 && fade > 0.5 ? heatCore * fade : 0;
      dotCoreHalo[i] = Math.min(1, Math.max(calmCore, apexCore * fade) / coreA);
    } else {
      dotCoreHalo[i] = 1;
    }
    // A blue-white star (./constellations) carries a white core of its own.
    const white = skyDots.white[i] as number;
    if (white > 0.02) {
      dotCore[i] = 1;
      dotCoreAlpha[i] = Math.max(dotCoreAlpha[i] as number, white * fade * dim);
    }
    dotCool[i] = ck;
    dotHalo[i] = apex ? 1 - ck + ck * CR.apexGlow : 1 - ck;
  }
  // The black hole's under-layer - the disk's halo, the shadow and its rim -
  // goes beneath the wires, so dots and wires passing in front of the shadow
  // really are in front of it.
  const bhEnv =
    bh > 0.001
      ? {
          ctx,
          bh,
          layout: BH_LAYOUT,
          pts,
          progress: windProgress,
          c,
          R,
          size,
          tSec,
          colors: { acc: accRgb, dim: dimRgb, hot: hotRgb, bg: bgRgb, heat, boost },
        }
      : null;
  if (bhEnv) drawBlackholeUnder(bhEnv);
  // The sphere warp's wormhole, under the wires that ring it.
  if (warpV === "sphere") {
    drawWarpSphere(ctx, et, c, R, tSec, { bright: briRgb, bg: bgRgb, boost });
  }
  // The sky fidgets' under-layers: Saturn's far ring half and globe, the
  // galaxy's bulge and arms, Algol's orbit - all beneath the wires. A figure
  // drawn during a turn takes the wires' ember, so the turn reads at its peak.
  const skyColors = { acc: briRgb, dim: dimRgbUse, hot: hotRgb, bg: bgRgb, boost };
  if (sat > 0.001) drawSaturnUnder({ ctx, k: sat, c, R, size, colors: skyColors });
  if (gal > 0.001) drawGalaxyUnder({ ctx, k: gal, c, R, size, tSec, colors: skyColors });
  if (alg > 0.001) drawAlgolUnder({ ctx, k: alg, c, R, size, colors: skyColors });
  // The crystal's own 24 edges and its travelling band, under the dots.
  drawCrystalUnder({
    ctx,
    k: ck,
    layout: CR_LAYOUT,
    edges: CR_EDGES,
    pts,
    depth: crDepth,
    // The still pose reads at a settled age, past the transient cues.
    ageSec: reduced ? 3 : (now - sim.crystalAt) / 1000,
    sinceAnswerMs: snap.crystalActive ? Number.POSITIVE_INFINITY : now - sim.answerAt,
    colors: { dim: dimRgbUse, cool: coolRgb, coolCore: coolCoreRgb, boost },
  });
  // The cinch's centre and ring, under the wires.
  const cinchEnv = cinchF
    ? {
        ctx,
        frame: cinchF,
        k: cinchK,
        gate: sim.cinchGate,
        c,
        R0,
        size,
        pts,
        still: reduced,
        colors: { dim: dimRgbUse, bright: briRgb, boost },
      }
    : null;
  if (cinchEnv) drawCinchUnder(cinchEnv, cinchFlight.arrival);
  // The halo takes the stronger of the ember and the crystal's cool light;
  // a flicker is a filament on the wires, so only a whisper of it spills
  // here (./flicker `glowSpill`).
  const halo = Math.min(1.6, (Math.max(neon, ck * 0.55) + spill) * sim.haloBoost);
  if (halo > 0.02) {
    // The halo: every glow-contributing primitive into one mask, blurred
    // once, composited under the geometry. See ./glow for why this
    // reproduces the per-primitive shadow it replaces.
    sim.glow = ensureGlowBuffers(sim.glow, canvas.width, canvas.height);
    compositeNeonHalo(
      ctx,
      sim.glow,
      {
        dpr,
        blurPx: firstmateGlowBlurPx(halo, size, dpr),
        tint: fmMix(fmMixRgb(hotRgb, [255, 236, 200], 0.3), coolCoreRgb, ck * 0.7),
        alpha: Math.min(1, 0.9 * halo),
      },
      (mask) => paintPrimitives(mask, pts, null, 1 / FM_GLOW_SPLIT),
    );
  }
  paintPrimitives(
    ctx,
    pts,
    { dim: dimRgbUse, bright: briRgb, cool: coolRgb, coolCore: coolCoreRgb },
    1,
  );
  ctx.globalAlpha = 1;
  // The sky fidgets' over-layers: a constellation's traced figure and its
  // nebula, Saturn's near ring half in front of the globe.
  if (con && skyK > 0.001) {
    drawConstellationOver({ ctx, k: skyK, et, con, c, R, size, colors: skyColors });
  }
  if (sat > 0.001) drawSaturnOver({ ctx, k: sat, c, R, size, colors: skyColors });
  // The cinch's motes streaming in to the centre, under the eyes.
  if (cinchEnv) drawCinchOver(cinchEnv, cinchFlight.motes);

  // ---- emote garnish: loose dots and sparks, line-art only ----
  if (state === "ponder") {
    // One dot drifts up and orbits like a loose thought.
    const k = band(et, 0.1, 0.2, 0.85, 0.15);
    if (k > 0.01) {
      const ang = et * 9;
      const ox = c - R * 0.75 + Math.cos(ang) * R * 0.16;
      const oy = c - R * (0.95 + et * 0.25) + Math.sin(ang) * R * 0.08;
      ctx.fillStyle = fmRgba(glowCol, 0.9 * k);
      ctx.beginPath();
      ctx.arc(ox, oy, 2.2 * (size / 280), 0, TAU);
      ctx.fill();
    }
  }
  if (state === "celebrate")
    drawSparkles(ctx, c, c, band(et, 0.12, 0.1, 0.7, 0.3), R * 1.5, glowRgb);
  if (fv === "orbit") {
    // Orbit fidget: one loose dot laps the structure with a short trail.
    const k = band(et, 0.08, 0.12, 0.88, 0.12);
    if (k > 0.01) {
      const ang = -Math.PI / 2 + easeInOut(clamp01((et - 0.1) / 0.75)) * TAU;
      for (let g2 = 0; g2 < 3; g2++) {
        const a2 = ang - g2 * 0.16;
        ctx.fillStyle = fmRgba(glowCol, (0.9 - g2 * 0.3) * k);
        ctx.beginPath();
        ctx.arc(
          c + Math.cos(a2) * R * 1.18,
          c + Math.sin(a2) * R * 0.85,
          (2.4 - g2 * 0.5) * (size / 280),
          0,
          TAU,
        );
        ctx.fill();
      }
    }
  }

  if (notice.strength > 0.005) {
    // The notice ring: line-art like every garnish, kept inside the canvas.
    ctx.strokeStyle = fmRgbaOf(glowRgb, 0.6 * notice.strength);
    ctx.lineWidth = 1.4 * (size / 280);
    ctx.beginPath();
    ctx.arc(c, c, Math.min(size * 0.48, R * (1.1 + 0.65 * notice.spread)), 0, TAU);
    ctx.stroke();
  }

  // ---- the eyes: two soft lights floating in the inner cell ----
  // They share the wire color family (ember while hot). During the pretend
  // black hole they become two hot spots caught in the disk, the far one
  // riding up its lensed arc (./blackhole).
  // A crystal keeps half the ember here and leans the light toward cool.
  const eyeBase: Rgb = fmMixRgb(fmMixRgb(accRgb, hotRgb, heatCore), coolRgb, 0.4 * ck);
  const eyeCol: Rgb = fmMixRgb(eyeBase, [255, 246, 230], Math.min(0.95, 0.45 + spill * 0.3));
  const eyeK = (1 - bh * 0.18) * cur.eyeScale;
  const gxo = sim.eye.x * R * 0.1;
  const gyo = sim.eye.y * R * 0.08;
  // Parallax from the rotation keeps them inside the structure; it fades out
  // as the flat listening form takes over (the rings are a plane).
  const pxo = Math.sin(sim.a) * R * 0.05 * (1 - f);
  const pyo = Math.sin(sim.b * 0.8) * R * 0.04 * (1 - f);
  type EyeSpot = {
    side: number;
    x: number;
    y: number;
    depthMul: number;
    /** Light factor: Algol's covered star fades. */
    alpha: number;
    /** Draw order: larger is nearer the viewer and painted last. */
    z: number;
  };
  const eyes: EyeSpot[] = [];
  for (const side of [-1, 1]) {
    const base = posePoint(c + side * R * 0.34 + gxo + pxo, c - R * 0.1 + gyo + pyo);
    if (alg > 0.001) {
      // Algol: the eyes are the eclipsing pair (./algol).
      eyes.push({ side, ...algolEye(alg, side, base, c, R, et) });
    } else {
      eyes.push({ side, ...blackholeEye(bh, side, base, c, R, tSec), alpha: 1, z: 0 });
    }
  }
  // The nearer of Algol's pair paints last, over the one it covers.
  if (alg > 0.001) eyes.sort((p, q) => p.z - q.z);
  const drawEye = (e: EyeSpot): void => {
    const lid = Math.max(sim.lid, e.side === 1 ? sim.wink : 0);
    const open = (1 - lid) * cur.eyeScale;
    const rw = R * 0.085 * eyeK * e.depthMul;
    const light = e.alpha * dim;
    // Socket haze in the app background grounds the eye against the wires.
    const sg = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rw * 3.2);
    sg.addColorStop(0, fmRgbaOf(bgRgb, 0.75));
    sg.addColorStop(1, fmRgbaOf(bgRgb, 0));
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(e.x, e.y, rw * 3.2, 0, TAU);
    ctx.fill();
    ctx.lineCap = "round";
    if (sim.happy > 0.5) {
      // Happy: the light bends into a small upward arc.
      ctx.strokeStyle = fmRgbaOf(eyeCol, 0.95 * light);
      ctx.lineWidth = Math.max(1.4, rw * 0.5);
      ctx.beginPath();
      ctx.arc(e.x, e.y + rw * 0.7, rw * 1.15, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else if (open < 0.12) {
      ctx.strokeStyle = fmRgbaOf(eyeCol, 0.8 * light);
      ctx.lineWidth = Math.max(1.2, rw * 0.4);
      ctx.beginPath();
      ctx.moveTo(e.x - rw, e.y);
      ctx.lineTo(e.x + rw, e.y);
      ctx.stroke();
    } else {
      const rh = rw * 1.35 * Math.max(0.1, open);
      const glowR = rw * (2.1 + spill * 0.5);
      const eg = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, glowR);
      eg.addColorStop(0, fmRgbaOf(eyeCol, 0.95 * light));
      eg.addColorStop(0.45, fmRgbaOf(eyeBase, 0.5 * light));
      eg.addColorStop(1, fmRgbaOf(eyeBase, 0));
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.arc(e.x, e.y, glowR, 0, TAU);
      ctx.fill();
      // The bright core leads the light along the gaze - the pupil of a
      // soft-light eye - by the configured fraction of the gaze offset.
      const lead = pointerSetup.pupilShift * (1 - bh);
      ctx.fillStyle = fmRgbaOf([255, 248, 235], 0.95 * light);
      ctx.beginPath();
      ctx.ellipse(e.x + gxo * lead, e.y + gyo * lead, rw * 0.62, rh * 0.62, 0, 0, TAU);
      ctx.fill();
    }
  };

  // The black hole's over-layer: the disk's streamlines with their lensed far
  // side, the wound wires, the escaping quanta. The eyes stay on top, as in
  // every other state.
  if (bhEnv) drawBlackholeOver(bhEnv);
  for (const e of eyes) drawEye(e);
  ctx.globalAlpha = 1;
  if (reply && isReplyEmote(state)) {
    drawReplyGarnish({
      ctx,
      emote: state,
      et,
      c,
      R,
      size,
      col: glowRgb,
      eyes,
      eyeR: R * 0.085 * eyeK,
      pose: posePoint,
    });
  }
}

/**
 * Zoom and display changes alter sharpness without changing CSS size.
 * Resize the backing only; keep the ongoing pose, gaze and emotes.
 * Says whether it resized, which leaves the canvas blank.
 */
export function fitBacking(canvas: HTMLCanvasElement, size: number): boolean {
  const backing = Math.round(size * (window.devicePixelRatio || 1));
  if (canvas.width === backing && canvas.height === backing) return false;
  canvas.width = backing;
  canvas.height = backing;
  return true;
}
