// The pirate styles (docs/ambient-music.md): Quiet cove, Tavern embers and
// Moonlit deck, each with the sea's soft wash under it, Tavern embers with
// soft rain outside and Moonlit deck with a soft night wind (INF-5569).
// Each layer's level in dB was measured by rendering every style one layer
// at a time, so every style plays as loud.

import { clamp } from "../composer";
import type { Style } from "../player";
import {
  AEOLIAN,
  DORIAN,
  DRUM,
  HELD,
  layers,
  MALLET,
  PADS,
  PENT_MINOR,
  PLUCK,
  pings,
  strum,
  triads,
  WOOD,
} from "./kit";

const CHIME = ["mallet", "cue", { ...MALLET.musicbox, amp: 1.4 }] as const;
const SPARK = ["pluck", "cue", { ...PLUCK.harp, amp: 0.6 }] as const;

/** A slow rocking rhythm: a concertina, a plucked lute, and a whistle tune when the crew is busy. */
export const QUIET_COVE: Style = {
  bpm: 46,
  beats: 2,
  grid: 3,
  hold: 2,
  tonic: 2,
  scale: DORIAN,
  pent: PENT_MINOR,
  chords: triads([
    ["i", 0],
    ["VII", 6],
    ["III", 2],
    ["IV", 3],
    ["v", 4],
  ]),
  start: "i",
  next: {
    i: ["VII", "III", "IV", "v", "VII"],
    VII: ["i", "i", "III"],
    III: ["VII", "IV", "i"],
    IV: ["i", "VII"],
    v: ["i", "III"],
  },
  cadence: ["VII", "i"],
  keys: { lo: 57, hi: 79, c: [64, 68], start: [62, 65, 69] },
  pad: {
    timbre: PADS.reed,
    anchors: [50, 57, 62],
    amp: 0.05,
    dip: 0.7,
    swell: 0.35,
    drift: [[0.23, 3]],
  },
  sea: true,
  reverb: 2.2,
  wet: 0.5,
  buses: {
    keys: [4200, 0.3, 0],
    lead: [4600, 0.55, 0],
    pad: [1500, 0.35, 0],
    kick: [900, 0.08, 0],
    rim: [2600, 0.1, 0],
  },
  gains: { pad: 9.5, keys: 5, bass: 1, kick: 3, rim: 8, lead: 2, star: 4.5 },
  trim: -0.5,
  levels: {
    0: { heat: 0, layers: layers(0.95, 0.95, 0.6, 0, 0, 0, 0, 0.6, 0) },
    1: { heat: 0.4, layers: layers(0.85, 0.85, 0.8, 0.65, 0, 0, 0, 0.4, 0) },
    2: { heat: 0.9, layers: layers(0.75, 0.85, 0.9, 0.75, 0.55, 0, 0.75, 0.3, 0) },
  },
  voices: {
    lute: ["pluck", "keys", PLUCK.lute],
    bass: ["pluck", "bass", PLUCK.upright],
    frame: ["drum", "kick", DRUM.frame],
    tap: ["wood", "rim", WOOD.tap],
    lead: ["sus", "lead", HELD.whistle],
    glint: ["mallet", "star", MALLET.kalimba],
    chime: CHIME,
    spark: SPARK,
  },
  cue: { vel: 0.075, sparkVel: 0.1, gain: [-3, -8.5] },
  compose(k) {
    const L = k.level;
    const v = k.voicing as [number, number, number];
    const b = k.bass(38);
    const low = b + 12;
    const seq: [number, number, number][] =
      L === 0
        ? [
            [0, low, 0.85],
            [3, v[1], 0.62],
            [4, v[2], 0.58],
          ]
        : [
            [0, low, 0.75],
            [1, v[0], 0.45],
            [2, v[1], 0.5],
            [3, v[2], 0.65],
            [4, v[1], 0.45],
            [5, v[0], 0.42],
          ];
    for (const [e, midi, vel] of seq)
      k.add(
        "lute",
        midi,
        k.step(e) + k.hum(),
        1.2,
        vel * (0.9 + k.rand() * 0.2),
        clamp((midi - 62) / 14, -0.5, 0.5),
      );
    k.add("bass", b, 0, 1.3, 0.85);
    if (L > 0) k.add("bass", b + 7, k.step(3), 0.9, 0.6);
    if (k.on("kick")) {
      k.add("frame", 0, 0, 0.3, 0.9);
      k.add("frame", 0, k.step(3), 0.3, 0.55);
      if (L > 1) k.add("frame", 0, k.step(5), 0.3, 0.38);
    }
    if (k.on("rim"))
      for (const e of [1, 2, 4])
        k.add("tap", 0, k.step(e) + k.hum(), 0.1, e === 2 ? 0.6 : 0.4, 0.2);
    pings(k, "glint", { p: 0.05 * k.layers.star, lo: 79, hi: 91, vel: [0.25, 0.4], pool: k.tones });
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "AB-AC-",
        center: 77,
        grace: 0.3,
        vel: 0.8,
        tail: 0.3,
        rhythms: [
          [
            [0, 2],
            [2, 1],
            [3, 2],
            [5, 1],
          ],
          [
            [0, 3],
            [3, 2],
            [5, 1],
          ],
          [
            [0, 2],
            [2, 1],
            [3, 3],
          ],
          [
            [0, 1],
            [1, 1],
            [2, 1],
            [3, 3],
          ],
          [
            [0, 2],
            [2, 1],
            [3, 1],
            [4, 1],
            [5, 1],
          ],
        ],
      });
  },
};

/** A quiet minor-key waltz: plucked strings, an accordion, and a fiddle tune when the crew is busy. */
export const TAVERN_EMBERS: Style = {
  bpm: 84,
  beats: 3,
  grid: 2,
  swing: 0,
  hold: 2,
  tonic: 9,
  scale: AEOLIAN,
  pent: PENT_MINOR,
  chords: triads([
    ["i", 0],
    ["iv", 3],
    ["V", 4, [0, 2, 4], { x: { 1: 1 } }],
    ["VI", 5],
    ["III", 2],
    ["VII", 6],
  ]),
  start: "i",
  next: {
    i: ["iv", "VI", "III", "V"],
    iv: ["i", "V", "VII"],
    V: ["i", "i", "VI"],
    VI: ["III", "iv", "V"],
    III: ["VII", "iv", "VI"],
    VII: ["III", "i"],
  },
  cadence: ["V", "i"],
  keys: { lo: 57, hi: 79, c: [64, 68], start: [60, 64, 69] },
  pad: {
    timbre: PADS.reed,
    anchors: [45, 52, 57],
    amp: 0.04,
    dip: 0.6,
    swell: 0.25,
    drift: [[0.2, 3]],
  },
  sea: true,
  rain: 0.5,
  reverb: 2,
  wet: 0.45,
  buses: {
    keys: [3800, 0.25, 0],
    lead: [3800, 0.5, 0],
    pad: [1300, 0.3, 0],
    kick: [900, 0.06, 0],
    rim: [2400, 0.08, 0],
    star: [9000, 1, 0],
  },
  gains: { pad: 11.5, keys: 7.5, bass: -0.5, kick: 3.5, rim: 10, lead: 10, star: 1.5 },
  trim: 1.5,
  levels: {
    0: { heat: 0, layers: layers(0.95, 0.95, 0.6, 0, 0, 0, 0, 0.8, 0) },
    1: { heat: 0.4, layers: layers(0.85, 0.85, 0.85, 0.55, 0, 0, 0, 0.5, 0) },
    2: { heat: 0.9, layers: layers(0.75, 0.85, 0.9, 0.65, 0.5, 0, 0.75, 0.3, 0) },
  },
  voices: {
    pizz: ["pluck", "keys", PLUCK.pizz],
    lute: ["pluck", "keys", PLUCK.lute],
    bass: ["pluck", "bass", PLUCK.upright],
    frame: ["drum", "kick", DRUM.frame],
    tap: ["wood", "rim", WOOD.tap],
    lead: ["sus", "lead", HELD.fiddle],
    box: ["mallet", "star", MALLET.musicbox],
    chime: CHIME,
    spark: SPARK,
  },
  cue: { vel: 0.075, sparkVel: 0.1, gain: [-3.5, -9] },
  compose(k) {
    const L = k.level;
    const v = k.voicing;
    const b = k.bass(40);
    k.add("bass", k.barInChord % 2 ? b + 7 : b, 0, 1.6, 0.85);
    if (L > 0) {
      for (const e of [2, 4])
        strum(k, "pizz", e, v, { spread: 0.012, vel: e === 2 ? 0.55 : 0.45, len: 0.5 });
    } else {
      k.add("lute", v[1] as number, k.step(2) + k.hum(), 1.2, 0.68, -0.2);
      if (k.chance(0.75)) k.add("lute", v[2] as number, k.step(4) + k.hum(), 1.2, 0.6, 0.2);
    }
    if (k.on("kick")) k.add("frame", 0, 0, 0.3, 0.8);
    if (k.on("rim")) for (const e of [2, 4]) k.add("tap", 0, k.step(e) + k.hum(), 0.1, 0.4, 0.2);
    pings(k, "box", {
      p: 0.07 * k.layers.star + 0.01,
      lo: 81,
      hi: 93,
      vel: [0.4, 0.6],
      pool: k.tones,
      len: 2.6,
    });
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "AABA-A-",
        center: 74,
        grace: 0.25,
        vel: 0.8,
        tail: 0.3,
        rhythms: [
          [
            [0, 2],
            [2, 2],
            [4, 2],
          ],
          [
            [0, 3],
            [3, 1],
            [4, 2],
          ],
          [
            [0, 4],
            [4, 2],
          ],
          [
            [0, 2],
            [2, 1],
            [3, 1],
            [4, 2],
          ],
          [[0, 6]],
        ],
      });
  },
};

/** Sparse and a little mysterious: a low drone, a music box tune, a slow harp, a distant whistle. */
export const MOONLIT_DECK: Style = {
  bpm: 58,
  beats: 4,
  grid: 2,
  swing: 0,
  hold: 2,
  tonic: 4,
  scale: AEOLIAN,
  pent: PENT_MINOR,
  chords: triads([
    ["i", 0, [0, 2, 4, 1]],
    ["VI", 5, [0, 2, 4, 6]],
    ["III", 2],
    ["VII", 6],
    ["iv", 3],
    ["v", 4],
  ]),
  start: "i",
  next: {
    i: ["VI", "iv", "III", "VII"],
    VI: ["III", "i", "VII"],
    III: ["VII", "VI", "iv"],
    VII: ["i", "i", "VI"],
    iv: ["i", "v", "VII"],
    v: ["i", "VI"],
  },
  cadence: ["VII", "i"],
  keys: { lo: 55, hi: 79, c: [62, 67], start: [59, 64, 67] },
  pad: {
    timbre: PADS.drone,
    anchors: [40, 47, 52],
    tones: [0, 2, 0],
    amp: 0.06,
    dip: 0.5,
    drift: [[0.18, 4]],
    wobble: [0.11, 110],
  },
  sea: true,
  wind: 0.6,
  reverb: 3,
  wet: 0.7,
  buses: {
    keys: [3400, 0.45, 0],
    lead: [3600, 0.9, 0],
    pad: [900, 0.4, 0],
    kick: [500, 0.3, 0],
    star: [8000, 1.1, 0],
  },
  gains: { pad: 9.5, keys: 0.5, bass: 3.5, kick: 2, lead: 0.5, star: 2 },
  trim: 1.5,
  levels: {
    0: { heat: 0, layers: layers(0.9, 0, 0.5, 0, 0, 0, 0, 1, 0) },
    1: { heat: 0.4, layers: layers(0.85, 0.8, 0.7, 0.6, 0, 0, 0, 0.9, 0) },
    2: { heat: 0.9, layers: layers(0.8, 0.85, 0.8, 0.7, 0, 0, 0.7, 0.8, 0) },
  },
  voices: {
    harp: ["pluck", "keys", PLUCK.harp],
    sub: ["sus", "bass", HELD.sub],
    deep: ["drum", "kick", DRUM.deep],
    lead: ["sus", "lead", HELD.whistle],
    box: ["mallet", "star", MALLET.musicbox],
    chime: CHIME,
    spark: SPARK,
  },
  cue: { vel: 0.075, sparkVel: 0.1, gain: [-4, -10] },
  compose(k) {
    const L = k.level;
    const v = k.voicing as [number, number, number];
    const b = k.bass(40);
    if (k.newChord) k.add("sub", b, 0, k.chordBars * 4 - 0.6, 0.8);
    if (k.on("keys")) {
      const run = k.barInChord % 2 ? [v[2], v[1], v[0], v[1]] : [b + 12, v[0], v[1], v[2]];
      for (const [i, midi] of run.entries())
        k.add(
          "harp",
          midi,
          k.step(i * 2) + k.hum(),
          2.4,
          (i === 0 ? 0.65 : 0.5) * (0.9 + k.rand() * 0.2),
          clamp((midi - 62) / 14, -0.5, 0.5),
        );
    }
    if (k.on("kick")) {
      k.add("deep", 0, 0, 0.6, 0.7);
      if (L > 1) k.add("deep", 0, k.step(5), 0.6, 0.4);
    }
    k.tune("box", {
      voice: "box",
      form: L === 0 ? "A-B-" : L === 1 ? "A--B--" : "A---",
      center: 84,
      pent: true,
      vel: 0.5,
      legato: 3,
      vary: 0.1,
      pan: -0.25,
      rhythms: [
        [
          [0, 2],
          [2, 2],
          [4, 4],
        ],
        [
          [0, 1],
          [1, 1],
          [2, 6],
        ],
        [
          [4, 2],
          [6, 2],
        ],
        [
          [0, 3],
          [3, 5],
        ],
      ],
    });
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "--A--B",
        center: 77,
        pent: true,
        vel: 0.7,
        legato: 0.98,
        tail: 0.6,
        vary: 0.1,
        pan: 0.35,
        rhythms: [
          [
            [0, 4],
            [4, 4],
          ],
          [
            [0, 6],
            [6, 2],
          ],
          [[2, 6]],
        ],
      });
  },
};
