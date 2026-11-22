// What the ambient music's styles are made from (docs/ambient-music.md):
// scales, instrument presets, the pad's timbres and a few ways of writing
// notes that more than one style uses.

import { type BarContext, type Chord, clamp, type Layer } from "../composer";
import type {
  DrumPreset,
  FmPreset,
  MalletPreset,
  PluckPreset,
  SusPreset,
  TickPreset,
  WoodPreset,
} from "../instruments";
import type { PadTimbre, Voice } from "../player";

export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
export const DORIAN = [0, 2, 3, 5, 7, 9, 10];
export const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
/** The five-note scales, as degrees of the seven. */
export const PENT_MAJOR = [0, 1, 2, 4, 5];
export const PENT_MINOR = [0, 2, 3, 4, 6];

export const GLASS: Voice = ["glass", "star", null];
export const FM_CELESTA: FmPreset = {
  ratio: 4,
  idx: 0.45,
  idxEnd: 0.02,
  idxT: 0.45,
  amp: 0.13,
  sus: 0.3,
  susTau: 0.35,
  rel: 0.3,
  tail: 1.5,
};

export const PLUCK = {
  uke: {
    mix: [
      ["triangle", 1],
      ["sawtooth", 0.18],
    ],
    bright: 7,
    dark: 1.6,
    sweep: 0.07,
    decay: 0.42,
    amp: 0.19,
  },
  lute: {
    mix: [
      ["sawtooth", 0.5],
      ["triangle", 0.7],
    ],
    bright: 9,
    dark: 1.8,
    sweep: 0.09,
    decay: 0.7,
    amp: 0.15,
  },
  guitar: {
    mix: [
      ["triangle", 1],
      ["sawtooth", 0.3],
    ],
    bright: 8,
    dark: 1.5,
    sweep: 0.1,
    decay: 0.85,
    amp: 0.17,
  },
  harp: {
    mix: [
      ["triangle", 1],
      ["sine", 0.5],
    ],
    bright: 5,
    dark: 1.3,
    sweep: 0.12,
    decay: 1.4,
    amp: 0.17,
  },
  pizz: {
    mix: [
      ["sawtooth", 0.5],
      ["triangle", 0.6],
    ],
    bright: 6,
    dark: 1.4,
    sweep: 0.05,
    decay: 0.2,
    amp: 0.17,
  },
  seq: {
    mix: [
      ["sawtooth", 0.45],
      ["square", 0.25],
    ],
    bright: 4.5,
    dark: 1.2,
    sweep: 0.12,
    decay: 0.28,
    amp: 0.12,
    q: 1.2,
  },
  upright: {
    mix: [
      ["sine", 1],
      ["triangle", 0.55],
    ],
    bright: 5,
    dark: 1.5,
    sweep: 0.08,
    decay: 0.7,
    amp: 0.3,
  },
} satisfies Record<string, PluckPreset>;

export const MALLET = {
  marimba: {
    partials: [
      [1, 1, 1],
      [4, 0.2, 0.18],
      [9.2, 0.04, 0.08],
    ],
    att: 0.003,
    amp: 0.16,
    ring: 0.9,
  },
  kalimba: {
    partials: [
      [1, 1, 1],
      [2, 0.12, 0.5],
      [5.4, 0.08, 0.15],
      [6.5, 0.03, 0.1],
    ],
    att: 0.003,
    amp: 0.13,
    ring: 1.3,
  },
  musicbox: {
    partials: [
      [1, 1, 1],
      [2, 0.3, 0.6],
      [3.01, 0.14, 0.4],
      [5.9, 0.05, 0.2],
    ],
    att: 0.003,
    amp: 0.085,
  },
  bell: {
    partials: [
      [0.5, 0.25, 1],
      [1, 1, 0.9],
      [1.19, 0.5, 0.7],
      [1.5, 0.35, 0.55],
      [2, 0.4, 0.5],
      [2.51, 0.15, 0.3],
      [3, 0.1, 0.25],
    ],
    att: 0.004,
    amp: 0.07,
  },
  sonar: {
    partials: [
      [1, 1, 1],
      [2, 0.06, 0.5],
    ],
    att: 0.012,
    amp: 1,
  },
  handbell: {
    partials: [
      [1, 1, 1],
      [2, 0.35, 0.6],
      [2.4, 0.2, 0.45],
      [3, 0.12, 0.3],
      [4.2, 0.05, 0.2],
    ],
    att: 0.004,
    amp: 1,
  },
} satisfies Record<string, MalletPreset>;

export const HELD = {
  sub: {
    osc: [
      ["sine", 1, 1],
      ["triangle", 0.15, 1],
    ],
    att: 0.9,
    rel: 0.7,
    amp: 0.15,
    sus: 1,
  },
  theremin: {
    osc: [
      ["sine", 1, 1],
      ["triangle", 0.07, 2],
    ],
    vib: [4.6, 13, 0.25, 0.5],
    att: 0.3,
    rel: 0.3,
    amp: 0.095,
    sus: 0.9,
    glide: 0.16,
  },
  synthLead: {
    osc: [
      ["triangle", 1, 1],
      ["square", 0.1, 1],
    ],
    lp: { k: 4, max: 2400 },
    vib: [5, 6, 0.3, 0.4],
    att: 0.07,
    rel: 0.22,
    amp: 0.105,
    sus: 0.8,
  },
  bugle: {
    osc: [
      ["sawtooth", 0.7, 1],
      ["sine", 0.5, 1],
    ],
    lp: { f: 1250 },
    vib: [4.8, 5, 0.45, 0.4],
    att: 0.08,
    rel: 0.16,
    amp: 0.085,
    sus: 0.8,
  },
  conch: {
    osc: [
      ["sawtooth", 0.6, 1],
      ["sine", 0.7, 1],
    ],
    lp: { f: 620 },
    att: 0.4,
    rel: 0.5,
    amp: 0.05,
    sus: 0.9,
  },
  whistle: {
    osc: [
      ["sine", 1, 1],
      ["sine", 0.07, 2],
      ["sine", 0.03, 3],
    ],
    vib: [5.6, 10, 0.18, 0.3],
    att: 0.04,
    rel: 0.09,
    amp: 0.1,
    sus: 0.8,
    scoop: -40,
  },
  flute: {
    osc: [
      ["sine", 1, 1],
      ["triangle", 0.12, 2],
      ["sine", 0.04, 3],
    ],
    vib: [4.8, 8, 0.25, 0.4],
    att: 0.07,
    rel: 0.14,
    amp: 0.115,
    sus: 0.8,
    scoop: -25,
  },
  noseflute: {
    osc: [
      ["sine", 1, 1],
      ["triangle", 0.09, 2],
    ],
    vib: [4.4, 11, 0.3, 0.5],
    att: 0.13,
    rel: 0.25,
    amp: 0.115,
    sus: 0.85,
    scoop: -30,
  },
  fiddle: {
    osc: [
      ["sawtooth", 0.6, 1],
      ["sawtooth", 0.25, 1, 6],
    ],
    lp: { k: 5, max: 3200, q: 0.8 },
    vib: [5.7, 13, 0.2, 0.3],
    att: 0.09,
    rel: 0.11,
    amp: 0.075,
    sus: 0.85,
    scoop: -20,
  },
  reedLead: {
    osc: [
      ["square", 0.3, 1],
      ["sawtooth", 0.35, 1, 6],
    ],
    lp: { f: 1500, q: 0.9 },
    vib: [5.2, 4, 0.3, 0.3],
    att: 0.06,
    rel: 0.1,
    amp: 0.075,
    sus: 0.85,
  },
} satisfies Record<string, SusPreset>;

export const DRUM = {
  kick: { f: [92, 48], drop: 0.11, decay: 0.34, amp: 0.5 },
  frame: { f: [105, 64], drop: 0.08, decay: 0.26, amp: 0.4, skin: [190, 0.1, 0.07] },
  pahu: { f: [78, 46], drop: 0.14, decay: 0.5, amp: 0.5, att: 0.006 },
  field: { f: [120, 80], drop: 0.06, decay: 0.2, amp: 0.3 },
  deep: { f: [66, 42], drop: 0.2, decay: 0.7, amp: 0.45, att: 0.012 },
} satisfies Record<string, DrumPreset>;

export const WOOD = {
  tap: {
    set: [
      [330, 0.25, 0.05],
      [760, 0.09, 0.03],
    ],
  },
  pate: {
    sets: [
      [
        [440, 0.3, 0.08],
        [1180, 0.07, 0.04],
      ],
      [
        [620, 0.28, 0.07],
        [1670, 0.07, 0.035],
      ],
    ],
    fall: 0.9,
  },
} satisfies Record<string, WoodPreset>;

export const SHAKER: TickPreset = { amp: 0.016, decay: 0.045, hp: 5000, f: [4800, 6900] };

export const PADS = {
  ice: {
    osc: [
      ["triangle", -6, 1, -0.6, 1],
      ["triangle", 6, 1, 0.6, 1],
    ],
    warm: ["sawtooth", 4, 1, 0.35],
    f: [700, 1100],
    q: 0.7,
  },
  strings: {
    osc: [
      ["sawtooth", -9, 0.4, -0.5, 1],
      ["sawtooth", 9, 0.4, 0.5, 1],
      ["sine", 0, 0.55, 0, 1],
    ],
    warm: ["sawtooth", 3, 2, 0.16],
    f: [620, 900],
    q: 0.6,
  },
  reed: {
    osc: [
      ["square", -7, 0.26, -0.35, 1],
      ["sawtooth", 7, 0.3, 0.35, 1],
    ],
    warm: ["sawtooth", 0, 2, 0.1],
    f: [1050, 700],
    q: 1.1,
  },
  horns: {
    osc: [
      ["sawtooth", -4, 0.5, -0.3, 1],
      ["sawtooth", 4, 0.5, 0.3, 1],
      ["sine", 0, 0.6, 0, 1],
    ],
    warm: null,
    f: [480, 620],
    q: 0.8,
  },
  choir: {
    osc: [
      ["sawtooth", -8, 0.5, -0.4, 1],
      ["sawtooth", 8, 0.5, 0.4, 1],
    ],
    warm: null,
    formants: [
      [320, 640, 5, 1],
      [800, 1100, 6, 0.5],
      [2300, 2500, 7, 0.1],
    ],
    f: [2400, 500],
    q: 0.5,
    lift: 0.9,
  },
  drone: {
    osc: [
      ["sawtooth", -5, 0.4, -0.2, 1],
      ["square", 5, 0.22, 0.2, 1],
    ],
    warm: null,
    f: [440, 380],
    q: 1.6,
  },
} satisfies Record<string, PadTimbre>;

/** Each layer's loudness at a crew level, in the order the styles write them. */
export const layers = (
  pad: number,
  keys: number,
  bass: number,
  kick: number,
  rim: number,
  tick: number,
  lead: number,
  star: number,
  arp = 0,
): Record<Layer, number> => ({ pad, keys, bass, kick, rim, tick, lead, star, arp });

/** Chords by name: [name, degree, tones, more]; tones default to a triad. */
export const triads = (
  names: [string, number, number[]?, Omit<Chord, "d" | "t">?][],
): Record<string, Chord> =>
  Object.fromEntries(names.map(([n, d, t, more]) => [n, { d, t: t || [0, 2, 4], ...more }]));

/** A strummed chord at a grid step, low to high or, `up`, high to low. */
export function strum(
  k: BarContext,
  voice: string,
  step: number,
  notes: number[],
  o: { up?: boolean; spread?: number; len?: number; vel?: number } = {},
): void {
  const order = o.up ? notes.slice().reverse() : notes;
  for (const [i, midi] of order.entries())
    k.add(
      voice,
      midi,
      k.step(step) + i * (o.spread || 0.02) + k.hum(),
      o.len || 1,
      (o.vel || 0.7) * (0.9 + k.rand() * 0.2),
      clamp((midi - 66) / 16, -0.5, 0.5),
    );
}

/** Sparse high pings, each grid step with chance `p`, between `lo` and `hi`. */
export function pings(
  k: BarContext,
  voice: string,
  o: { p: number; lo: number; hi: number; vel: [number, number]; pool?: number[]; len?: number },
): void {
  for (let e = 0; e < k.steps; e += 1)
    if (k.chance(o.p)) {
      const midi = k.near(o.lo + k.rand() * (o.hi - o.lo), o.pool || k.pentPcs);
      k.add(
        voice,
        midi,
        k.step(e) + k.rand() * 0.06,
        o.len || 2,
        o.vel[0] + k.rand() * (o.vel[1] - o.vel[0]),
        k.rand() * 1.6 - 0.8,
      );
    }
}
