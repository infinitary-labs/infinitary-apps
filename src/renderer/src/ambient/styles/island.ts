// The island voyaging styles (docs/ambient-music.md): Wayfinder night and
// Island morning, each with the sea's soft wash under it. They take the
// feel of Pacific voyaging music - humming voices, log drums, thumb piano,
// bamboo flute - and no tune or sound from anywhere else. Each layer's
// level in dB was measured by rendering every style one layer at a time,
// so every style plays as loud.

import { pitchClass, upTo } from "../composer";
import type { Style } from "../player";
import {
  DRUM,
  GLASS,
  HELD,
  layers,
  MAJOR,
  MALLET,
  PADS,
  PENT_MAJOR,
  PLUCK,
  pings,
  SHAKER,
  strum,
  triads,
  WOOD,
} from "./kit";

const CHIME = ["mallet", "cue", { ...MALLET.marimba, amp: 1.3, ring: 1.6 }] as const;
const SPARK = ["mallet", "cue", { ...MALLET.kalimba, amp: 1.1, ring: 1.4 }] as const;

/** Humming voices on open chords, a thumb piano, a slow two-beat drum, and a slow falling flute tune. */
export const WAYFINDER_NIGHT: Style = {
  bpm: 60,
  beats: 4,
  grid: 2,
  swing: 0,
  hold: 2,
  tonic: 7,
  scale: MAJOR,
  pent: PENT_MAJOR,
  chords: triads([
    ["I", 0],
    ["IV", 3],
    ["V", 4],
    ["vi", 5],
  ]),
  start: "I",
  next: {
    I: ["IV", "V", "vi", "IV"],
    IV: ["I", "I", "V"],
    V: ["I", "vi", "IV"],
    vi: ["IV", "V"],
  },
  cadence: ["V", "I"],
  keys: { lo: 57, hi: 81, c: [65, 70], start: [62, 67, 71] },
  pad: {
    timbre: PADS.choir,
    anchors: [43, 50, 59],
    amp: 0.06,
    dip: 0.45,
    glide: 0.25,
    drift: [
      [0.17, 3],
      [4.9, 5],
    ],
  },
  sea: true,
  reverb: 3.2,
  wet: 0.75,
  buses: {
    keys: [5200, 0.5, 0],
    lead: [3200, 0.8, 0],
    pad: [2600, 0.6, 0],
    kick: [500, 0.2, 0],
    star: [10000, 1.1, 0],
  },
  gains: { pad: 4.5, keys: 8, bass: 1, kick: 1.5, lead: -0.5, star: 0 },
  trim: 0,
  levels: {
    0: { heat: 0, layers: layers(1, 0.9, 0.7, 0, 0, 0, 0, 1, 0) },
    1: { heat: 0.4, layers: layers(0.9, 0.85, 0.75, 0.6, 0, 0, 0, 0.7, 0) },
    2: { heat: 0.9, layers: layers(0.85, 0.85, 0.8, 0.7, 0, 0, 0.75, 0.5, 0) },
  },
  voices: {
    kalimba: ["mallet", "keys", MALLET.kalimba],
    sub: ["sus", "bass", HELD.sub, 5],
    bass: ["bass", "bass", null],
    pahu: ["drum", "kick", DRUM.pahu],
    lead: ["sus", "lead", HELD.noseflute],
    conch: ["sus", "star", HELD.conch],
    star: GLASS,
    chime: CHIME,
    spark: SPARK,
  },
  cue: { vel: 0.09, sparkVel: 0.08, gain: [-3, -4] },
  compose(k) {
    const L = k.level;
    const b = k.bass(36);
    if (k.newChord) {
      if (L === 0) k.add("sub", b, 0, k.chordBars * 4 - 0.6, 0.8);
      k.memo.ost = [0, 1, 2, 3].map(() =>
        k.near(67 + k.rand() * 15, k.tones.concat(k.pentPcs), 64, 84),
      );
    }
    const ost = k.memo.ost ?? [];
    if (L === 0) {
      k.add("kalimba", ost[0] as number, k.hum() + 0.01, 1.4, 1, -0.2);
      if (k.chance(0.5)) k.add("kalimba", ost[2] as number, k.step(4) + k.hum(), 1.4, 0.8, 0.2);
    } else
      for (const [i, e] of [0, 3, 4, 6].entries())
        k.add(
          "kalimba",
          ost[i] as number,
          k.step(e) + k.hum(),
          1.4,
          e === 0 ? 1 : 0.75,
          (i - 1.5) * 0.25,
        );
    if (L > 0) k.add("bass", b, 0, 2.4, 0.7);
    if (k.on("kick"))
      for (const [e, vel] of [
        [0, 0.8],
        [1, 0.42],
        [4, 0.65],
        [5, 0.36],
      ] as const)
        k.add("pahu", 0, k.step(e), 0.5, vel);
    pings(k, "star", { p: 0.12 * k.layers.star + 0.02, lo: 85, hi: 99, vel: [0.03, 0.05] });
    // The conch: a far call, now and then, when nobody is working.
    if (L === 0 && k.index % 8 === 5 && k.chance(0.6)) {
      const low = upTo(50, pitchClass(k.s.tonic + 7));
      k.add("conch", low, 0, 2.2, 0.8, 0.4);
      k.add("conch", upTo(low, k.s.tonic), 2, 3.4, 0.9, 0.4);
    }
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "A-B-",
        center: 76,
        pent: true,
        vel: 0.8,
        legato: 0.98,
        tail: 0.6,
        vary: 0.1,
        rhythms: [
          [
            [0, 3],
            [3, 1],
            [4, 4],
          ],
          [
            [0, 2],
            [2, 6],
          ],
          [
            [0, 6],
            [6, 2],
          ],
          [
            [1, 1],
            [2, 2],
            [4, 4],
          ],
        ],
        moves: [-1, -1, -2, -1, 1, 0],
        starts: [4, 7, 2],
      });
  },
};

/** The brightest one, still unhurried: a marimba pattern, a lilting bass, and a flute tune. */
export const ISLAND_MORNING: Style = {
  bpm: 84,
  beats: 4,
  grid: 2,
  swing: 0.08,
  hold: 2,
  tonic: 2,
  scale: MAJOR,
  pent: PENT_MAJOR,
  chords: triads([
    ["I", 0],
    ["IV", 3],
    ["V", 4],
    ["vi", 5],
    ["ii", 1],
  ]),
  start: "I",
  next: {
    I: ["IV", "vi", "V"],
    IV: ["I", "V", "ii"],
    V: ["I", "vi"],
    vi: ["IV", "ii"],
    ii: ["V", "IV"],
  },
  cadence: ["V", "I"],
  keys: { lo: 60, hi: 81, c: [66, 70], start: [62, 66, 69] },
  pad: { timbre: PADS.strings, anchors: [50, 57, 62], amp: 0.035, glide: 0.25, drift: [[0.2, 3]] },
  sea: true,
  reverb: 2,
  wet: 0.5,
  buses: {
    keys: [5200, 0.3, 0],
    lead: [4200, 0.5, 0],
    kick: [700, 0.05, 0],
    rim: [3200, 0.12, 0],
    tick: [9000, 0.04, 0],
    arp: [3600, 0.2, 0],
  },
  gains: {
    pad: 7.5,
    keys: 8,
    bass: 0.5,
    kick: 1.5,
    rim: 7.5,
    tick: 3.5,
    lead: 2,
    star: 4,
    arp: 0.5,
  },
  trim: -0.5,
  levels: {
    0: { heat: 0, layers: layers(1.2, 1.15, 0.6, 0, 0, 0, 0, 0.6, 0) },
    1: { heat: 0.4, layers: layers(0.85, 0.85, 0.8, 0.55, 0, 0, 0, 0.4, 0) },
    2: { heat: 0.9, layers: layers(0.8, 0.85, 0.9, 0.65, 0.55, 0.5, 0.7, 0.3, 0.7) },
  },
  voices: {
    marimba: ["mallet", "keys", MALLET.marimba],
    bass: ["pluck", "bass", PLUCK.upright],
    pahu: ["drum", "kick", DRUM.pahu],
    pate: ["wood", "rim", WOOD.pate],
    shake: ["tick", "tick", SHAKER],
    uke: ["pluck", "arp", PLUCK.uke],
    lead: ["sus", "lead", HELD.flute],
    star: ["mallet", "star", MALLET.kalimba],
    chime: CHIME,
    spark: SPARK,
  },
  cue: { vel: 0.09, sparkVel: 0.08, gain: [-3, -4] },
  compose(k) {
    const L = k.level;
    const v = k.voicing as [number, number, number];
    const set = [v[0], v[1], v[2], v[0] + 12, v[1] + 12];
    const b = k.bass(38);
    if (L === 0) {
      for (const [e, i, vel] of [
        [0, 0, 1],
        [3, 2, 0.8],
        [6, 3, 0.85],
      ] as const)
        k.add("marimba", set[i] as number, k.step(e) + k.hum(), 1, vel, (i - 1.5) * 0.25);
      if (k.newChord) k.add("bass", b, 0, 2, 0.7);
    } else {
      const pat = k.barInChord % 2 ? [0, 2, 3, 2, 4, 3, 2, 1] : [0, 2, 1, 3, 2, 4, 3, 2];
      for (const [e, i] of pat.entries())
        k.add(
          "marimba",
          set[i] as number,
          k.step(e) + k.hum(),
          0.9,
          e === 0 || e === 3 || e === 6 ? 1 : 0.6,
          (i - 2) * 0.22,
        );
      k.add("bass", b, 0, 1.3, 0.85);
      k.add("bass", b + 7, k.step(3), 1.2, 0.6);
      k.add("bass", b + (k.chance(0.5) ? 12 : 7), k.step(6), 0.9, 0.6);
    }
    if (k.on("kick")) {
      k.add("pahu", 0, 0, 0.5, 0.8);
      k.add("pahu", 0, k.step(4), 0.5, 0.5);
    }
    if (k.on("rim"))
      for (const [i, e] of [2, 3, 5, 7].entries())
        k.add("pate", i % 2, k.step(e) + k.hum(), 0.1, i === 0 ? 0.55 : 0.4, i % 2 ? 0.35 : -0.35);
    if (k.on("tick"))
      for (let e = 0; e < 8; e += 1)
        k.add("shake", 0, k.step(e) + k.hum(), 0.05, e % 2 ? 0.85 : 0.45);
    if (k.on("arp"))
      for (const e of [2, 6])
        strum(k, "uke", e, [v[1], v[2], v[0] + 12], {
          up: true,
          spread: 0.012,
          vel: 0.42,
          len: 0.3,
        });
    pings(k, "star", { p: 0.05 * k.layers.star, lo: 81, hi: 93, vel: [0.25, 0.4] });
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "AAB-",
        center: 79,
        pent: true,
        vel: 0.78,
        tail: 0.3,
        rhythms: [
          [
            [0, 1],
            [1, 1],
            [2, 2],
            [4, 4],
          ],
          [
            [0, 2],
            [2, 1],
            [3, 3],
            [6, 2],
          ],
          [
            [0, 3],
            [3, 1],
            [4, 2],
            [6, 2],
          ],
          [
            [2, 1],
            [3, 1],
            [4, 4],
          ],
        ],
      });
  },
};
