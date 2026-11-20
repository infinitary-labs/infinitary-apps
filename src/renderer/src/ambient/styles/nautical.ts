// The nautical styles (docs/ambient-music.md): Harbor dawn and Fair winds,
// each with the sea's soft wash under it. Each layer's level in dB was
// measured by rendering every style one layer at a time, so every style
// plays as loud.

import { clamp, pitchClass, upTo } from "../composer";
import type { Style } from "../player";
import {
  DRUM,
  HELD,
  layers,
  MAJOR,
  MALLET,
  PADS,
  PENT_MAJOR,
  PLUCK,
  strum,
  triads,
  WOOD,
} from "./kit";

const CHIME = ["mallet", "cue", MALLET.handbell] as const;
const SPARK = ["pluck", "cue", { ...PLUCK.harp, amp: 0.6 }] as const;

/** Slow and stately: soft brass chords, a harp, a ship's bell struck in pairs, and a distant bugle. */
export const HARBOR_DAWN: Style = {
  bpm: 56,
  beats: 4,
  grid: 2,
  swing: 0,
  hold: 2,
  tonic: 10,
  scale: MAJOR,
  pent: PENT_MAJOR,
  chords: triads([
    ["I", 0],
    ["IV", 3, [0, 2, 4, 1]],
    ["V", 4, [0, 3, 4], { hold: 1 }],
    // i18n-exempt: a chord's name inside the composer, never shown.
    ["Vr", 4, [0, 2, 4], { hold: 1 }],
    ["vi", 5, [0, 2, 4, 6]],
    ["ii", 1, [0, 2, 4, 6]],
  ]),
  start: "I",
  next: {
    I: ["IV", "vi", "V", "IV"],
    IV: ["I", "V", "ii"],
    // i18n-exempt: a chord's name inside the composer, never shown.
    V: ["Vr"],
    Vr: ["I", "vi"],
    vi: ["IV", "ii"],
    ii: ["V", "IV"],
  },
  cadence: ["V", "I"],
  keys: { lo: 55, hi: 79, c: [62, 67], start: [58, 62, 65] },
  pad: { timbre: PADS.horns, anchors: [46, 53, 58], amp: 0.05, dip: 0.75, drift: [[0.16, 2]] },
  sea: true,
  reverb: 2.8,
  wet: 0.65,
  buses: {
    keys: [3600, 0.4, 0],
    lead: [2400, 0.8, 0],
    pad: [1300, 0.5, 0],
    kick: [700, 0.1, 0],
    star: [7000, 0.9, 0],
  },
  gains: { pad: 3, keys: -1.5, bass: -1, kick: 5, lead: 3, star: 0.5 },
  trim: 0,
  levels: {
    0: { heat: 0, layers: layers(1, 0.9, 0.7, 0, 0, 0, 0, 1, 0) },
    1: { heat: 0.4, layers: layers(0.9, 0.85, 0.75, 0.5, 0, 0, 0, 0.8, 0) },
    2: { heat: 0.9, layers: layers(0.8, 0.85, 0.85, 0.6, 0, 0, 0.75, 0.6, 0) },
  },
  voices: {
    harp: ["pluck", "keys", PLUCK.harp],
    sub: ["sus", "bass", HELD.sub, 5],
    bass: ["bass", "bass", null],
    field: ["drum", "kick", DRUM.field],
    lead: ["sus", "lead", HELD.bugle],
    bell: ["mallet", "star", MALLET.bell],
    chime: CHIME,
    spark: SPARK,
  },
  cue: { vel: 0.06, sparkVel: 0.1, ring: 2.8, gain: [0, -9] },
  compose(k) {
    const L = k.level;
    const v = k.voicing as [number, number, number];
    const b = k.bass(38);
    if (L === 0) {
      if (k.newChord) k.add("sub", b, 0, k.chordBars * 4 - 0.6, 0.8);
      k.add("harp", b + 12, k.hum() + 0.01, 3, 0.7, -0.2);
      if (k.chance(0.8)) k.add("harp", v[1], k.step(4) + k.hum(), 3, 0.58, 0.2);
      if (k.chance(0.4)) k.add("harp", v[2], k.step(6) + k.hum(), 3, 0.5, 0.35);
    } else {
      k.add("bass", b, 0, 2.6, 0.85);
      k.add("bass", b, k.step(4), 1.6, 0.6);
      const run: [number, number, number][] = [
        [0, b + 12, 0.65],
        [2, v[0], 0.48],
        [3, v[1], 0.45],
        [4, v[2], 0.58],
        [6, v[1], 0.45],
      ];
      for (const [e, midi, vel] of run)
        k.add(
          "harp",
          midi,
          k.step(e) + k.hum(),
          2.6,
          vel * (0.9 + k.rand() * 0.2),
          clamp((midi - 62) / 14, -0.5, 0.5),
        );
    }
    if (k.on("kick")) {
      k.add("field", 0, 0, 0.2, 0.7);
      if (L > 1) {
        k.add("field", 0, k.step(4), 0.2, 0.5);
        k.add("field", 0, k.step(7), 0.2, 0.3);
      }
    }
    // The ship's bell: struck in pairs, as a watch is told.
    if (k.index % 4 === 2 && k.chance(0.35 + 0.5 * k.layers.star)) {
      const bell = upTo(72, pitchClass(k.s.tonic + 7));
      const pairs = k.pick([1, 1, 2]);
      for (let p = 0; p < pairs; p += 1) {
        k.add("bell", bell, p * 1.6, 9, 0.5, -0.3);
        k.add("bell", bell, p * 1.6 + 0.45, 9, 0.42, -0.3);
      }
    }
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "A-B-A-C-",
        center: 70,
        chordOnly: true,
        vel: 0.8,
        legato: 0.95,
        tail: 0.5,
        vary: 0,
        pan: 0.3,
        rhythms: [
          [
            [0, 3],
            [3, 1],
            [4, 4],
          ],
          [
            [0, 2],
            [2, 2],
            [4, 4],
          ],
          [
            [0, 6],
            [6, 2],
          ],
          [
            [0, 4],
            [4, 2],
            [6, 2],
          ],
        ],
        starts: [0, 2, 4],
        moves: [-2, 2, 2, -2, 3, -3, 0],
      });
  },
};

/** An easy shanty rhythm on guitar; a whistle plays a phrase and a concertina answers it. */
export const FAIR_WINDS: Style = {
  bpm: 66,
  beats: 4,
  grid: 2,
  swing: 0.06,
  hold: 1,
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
    I: ["IV", "V", "vi", "IV", "I"],
    IV: ["I", "V", "I"],
    V: ["I", "vi", "I"],
    vi: ["IV", "ii"],
    ii: ["V"],
  },
  cadence: ["V", "I"],
  keys: { lo: 57, hi: 79, c: [64, 68], start: [62, 66, 69] },
  pad: {
    timbre: PADS.reed,
    anchors: [50, 57, 62],
    amp: 0.042,
    dip: 0.6,
    swell: 0.3,
    drift: [[0.22, 3]],
  },
  sea: true,
  reverb: 2.2,
  wet: 0.5,
  buses: {
    keys: [4000, 0.28, 0],
    lead: [4600, 0.5, 0],
    pad: [1500, 0.35, 0],
    kick: [900, 0.06, 0],
    rim: [2600, 0.08, 0],
    arp: [1700, 0.4, 0],
  },
  gains: { pad: 11.5, keys: 3, bass: 1.5, kick: 4.5, rim: 9, lead: 2.5, arp: 6.5 },
  trim: 0.5,
  levels: {
    0: { heat: 0, layers: layers(0.95, 0.95, 0.6, 0, 0, 0, 0, 0, 0) },
    1: { heat: 0.4, layers: layers(0.85, 0.85, 0.8, 0.6, 0, 0, 0, 0, 0) },
    2: { heat: 0.9, layers: layers(0.75, 0.85, 0.9, 0.7, 0.5, 0, 0.75, 0, 0.8) },
  },
  voices: {
    guitar: ["pluck", "keys", PLUCK.guitar],
    bass: ["pluck", "bass", PLUCK.upright],
    frame: ["drum", "kick", DRUM.frame],
    tap: ["wood", "rim", WOOD.tap],
    call: ["sus", "lead", HELD.whistle],
    answer: ["sus", "arp", HELD.reedLead],
    chime: CHIME,
    spark: SPARK,
  },
  cue: { vel: 0.06, sparkVel: 0.1, ring: 2.8, gain: [1, -9] },
  compose(k) {
    const L = k.level;
    const v = k.voicing as [number, number, number];
    const b = k.bass(38);
    const low = b + 12;
    if (L === 0) {
      const picked: [number, number, number][] = [
        [0, low, 0.85],
        [3, v[1], 0.6],
        [4, v[0], 0.66],
        [6, v[2], 0.6],
      ];
      for (const [e, midi, vel] of picked)
        k.add("guitar", midi, k.step(e) + k.hum(), 1.8, vel, clamp((midi - 62) / 14, -0.5, 0.5));
      k.add("bass", b, 0, 1.6, 0.7);
    } else {
      k.add("guitar", low, k.hum() + 0.01, 1.2, 0.7, -0.2);
      strum(k, "guitar", 2, v, { vel: 0.48, len: 0.7 });
      k.add("guitar", low + (pitchClass(low) < 5 ? 7 : -5), k.step(4) + k.hum(), 1.2, 0.6, -0.2);
      strum(k, "guitar", 6, v, { vel: 0.42, len: 0.7, up: true });
      k.add("bass", b, 0, 1.5, 0.85);
      k.add("bass", b + 7, k.step(4), 1.3, 0.65);
    }
    if (k.on("kick")) {
      k.add("frame", 0, 0, 0.3, 0.8);
      k.add("frame", 0, k.step(4), 0.3, 0.55);
    }
    if (k.on("rim")) {
      k.add("tap", 0, k.step(2) + k.hum(), 0.1, 0.5, 0.2);
      k.add("tap", 0, k.step(6) + k.hum(), 0.1, 0.5, 0.2);
      if (k.chance(0.5)) k.add("tap", 0, k.step(7) + k.hum(), 0.1, 0.3, 0.2);
    }
    if (k.layers.lead > 0 && !k.resolved) {
      const rhythms: [number, number][][] = [
        [
          [0, 2],
          [2, 1],
          [3, 1],
          [4, 4],
        ],
        [
          [0, 3],
          [3, 1],
          [4, 2],
          [6, 2],
        ],
        [
          [0, 2],
          [2, 2],
          [4, 3],
          [7, 1],
        ],
        [
          [0, 1],
          [1, 1],
          [2, 2],
          [4, 4],
        ],
      ];
      k.tune("call", {
        voice: "call",
        form: "AB--",
        center: 79,
        grace: 0.25,
        vel: 0.8,
        tail: 0.3,
        rhythms,
        pan: 0.3,
      });
      k.tune("answer", {
        voice: "answer",
        form: "--AC",
        share: "call",
        center: 69,
        harm: -2,
        vel: 0.8,
        tail: 0.3,
        rhythms,
        pan: -0.3,
      });
    }
  },
};
