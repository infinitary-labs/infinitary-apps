// The space travel styles (docs/ambient-music.md): Deep drift and Star
// cruise, the default. Each layer's level in dB was measured by rendering
// every style one layer at a time, so every style plays as loud.

import { pitchClass } from "../composer";
import type { Style } from "../player";
import {
  AEOLIAN,
  DRUM,
  FM_CELESTA,
  GLASS,
  HELD,
  LYDIAN,
  layers,
  MALLET,
  PADS,
  PENT_MAJOR,
  PENT_MINOR,
  PLUCK,
  pings,
  triads,
} from "./kit";

/** No drums: slow wide chords, a few high pings with long echoes, a gliding voice when the crew is busy. */
export const DEEP_DRIFT: Style = {
  bpm: 52,
  beats: 4,
  grid: 2,
  swing: 0,
  hold: 2,
  tonic: 2,
  scale: LYDIAN,
  pent: PENT_MAJOR,
  chords: triads([
    ["I", 0, [0, 2, 4, 6]],
    ["II", 1, [0, 2, 4], { b: 0 }],
    ["vi", 5, [0, 2, 4, 6]],
    ["iii", 2, [0, 2, 4, 6]],
    ["V", 4, [0, 2, 4, 1]],
  ]),
  start: "I",
  next: {
    I: ["II", "vi", "iii", "II"],
    II: ["I", "I", "vi"],
    vi: ["iii", "I", "II"],
    iii: ["vi", "I"],
    V: ["I"],
  },
  cadence: ["V", "I"],
  keys: { lo: 57, hi: 84, c: [66, 72], start: [62, 66, 69, 73] },
  pad: { timbre: PADS.ice, anchors: [50, 57, 64], amp: 0.055, glide: 0.5, drift: [[0.17, 4]] },
  reverb: 3.2,
  wet: 0.75,
  echo: { beats: 0.75, fb: 0.45, lp: 2400, mix: 0.7 },
  buses: {
    star: [9000, 0.9, 0.7],
    arp: [5200, 0.6, 0.45],
    lead: [3600, 0.8, 0.25],
    bass: [300, 0.1, 0],
  },
  gains: { pad: 0, bass: 1, lead: 2, star: 1, arp: 7.5 },
  trim: 1,
  levels: {
    0: { heat: 0, layers: layers(1, 0, 0.7, 0, 0, 0, 0, 1, 0) },
    1: { heat: 0.4, layers: layers(1, 0, 0.8, 0, 0, 0, 0, 0.8, 0.75) },
    2: { heat: 0.85, layers: layers(0.95, 0, 0.9, 0, 0, 0, 0.7, 0.6, 0.9) },
  },
  voices: {
    sub: ["sus", "bass", HELD.sub],
    ping: ["mallet", "star", MALLET.sonar],
    arp: ["glass", "arp", null],
    lead: ["sus", "lead", HELD.theremin],
    chime: ["mallet", "cue", MALLET.sonar],
    spark: ["glass", "cue", null],
  },
  cue: { vel: 0.07, ring: 2.8, gain: [-0.5, 1] },
  compose(k) {
    const L = k.level;
    if (k.newChord) k.add("sub", k.bass(38), 0, k.chordBars * 4 - 0.6, 0.85);
    if (k.chance(0.34 * k.layers.star + 0.06))
      k.add(
        "ping",
        k.near(79 + k.rand() * 10, k.tones.slice(0, 3)),
        k.step(k.pick([0, 2, 3, 5, 6])),
        5,
        0.045 + k.rand() * 0.02,
        k.rand() * 1.2 - 0.6,
      );
    if (k.on("arp")) {
      const pool = k.tones.concat(pitchClass(k.s.tonic + 6));
      for (let e = 0; e < 8; e += 1) {
        if (!(e % 2 === 0 ? k.chance(L > 1 ? 0.9 : 0.7) : L > 1 && k.chance(0.4))) continue;
        let midi = k.near(69 + k.rand() * 19, pool, 66, 91);
        if (midi === k.memo.arp) midi = k.near(midi + (k.chance(0.5) ? 4 : -4), pool, 66, 91);
        k.memo.arp = midi;
        k.add("arp", midi, k.step(e) + k.hum(), 3.2, e % 2 ? 0.03 : 0.045, k.rand() * 1.4 - 0.7);
      }
    }
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "A-B-A-C-",
        center: 76,
        pan: 0.2,
        vel: 0.8,
        legato: 1,
        tail: 0.5,
        vary: 0.1,
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
          [
            [0, 3],
            [3, 5],
          ],
        ],
        starts: [0, 2, 4, 6],
        moves: [-2, -1, 1, 2, -3, 3],
      });
  },
};

/** A soft repeating note pattern that echoes left and right, over a slow low pulse. */
export const STAR_CRUISE: Style = {
  bpm: 76,
  beats: 4,
  grid: 2,
  swing: 0,
  hold: 2,
  tonic: 9,
  scale: AEOLIAN,
  pent: PENT_MINOR,
  chords: triads([
    ["i", 0, [0, 2, 4, 6]],
    ["VI", 5, [0, 2, 4, 6]],
    ["III", 2, [0, 2, 4, 6]],
    ["VII", 6, [0, 2, 4, 1]],
    ["iv", 3, [0, 2, 4, 6]],
    ["v", 4, [0, 2, 4, 6]],
  ]),
  start: "i",
  next: {
    i: ["VI", "III", "iv", "VI"],
    VI: ["III", "VII", "i"],
    III: ["VII", "VI", "iv"],
    VII: ["i", "i", "v"],
    iv: ["i", "VII", "v"],
    v: ["i", "VI"],
  },
  cadence: ["VII", "III"],
  keys: { lo: 55, hi: 81, c: [64, 69], start: [60, 64, 67, 69] },
  pad: {
    timbre: PADS.strings,
    anchors: [45, 52, 59],
    amp: 0.042,
    glide: 0.3,
    drift: [[0.19, 4]],
  },
  reverb: 2.6,
  wet: 0.6,
  echo: { beats: 0.75, fb: 0.38, lp: 2200, mix: 0.75 },
  buses: { arp: [2600, 0.3, 0.5], lead: [3200, 0.55, 0.3], star: [9000, 1, 0.5] },
  gains: { pad: 5.5, bass: -2, kick: 0.5, tick: 2.5, lead: 2, star: 3, arp: 10.5 },
  trim: 0,
  levels: {
    0: { heat: 0, layers: layers(1, 0, 0.7, 0, 0, 0, 0, 0.7, 0.8) },
    1: { heat: 0.45, layers: layers(0.85, 0, 0.8, 0.6, 0, 0, 0, 0.45, 0.8) },
    2: { heat: 1, layers: layers(0.75, 0, 0.9, 0.7, 0, 0.5, 0.65, 0.3, 0.95) },
  },
  voices: {
    sub: ["sus", "bass", HELD.sub, 5],
    bass: ["bass", "bass", null],
    kick: ["drum", "kick", DRUM.kick],
    tick: ["tick", "tick", null],
    seq: ["pluck", "arp", PLUCK.seq],
    lead: ["sus", "lead", HELD.synthLead],
    star: GLASS,
    chime: ["fm", "cue", { ...FM_CELESTA, amp: 0.6, tail: 2.4 }],
    spark: ["glass", "cue", null],
  },
  cue: { vel: 0.11, gain: [-3.5, 1] },
  compose(k) {
    const L = k.level;
    const v = k.voicing;
    if (k.newChord || !k.memo.pat)
      k.memo.pat = k.pick([
        [0, 1, 2, 3, 2, 1, 2, 3],
        [0, 2, 1, 3, 2, 3, 1, 2],
        [0, 1, 2, 1, 3, 2, 1, 2],
        [0, 2, 3, 2, 1, 2, 3, 2],
      ]);
    const pat = k.memo.pat;
    const ext = v.concat([(v[0] as number) + 12, (v[1] as number) + 12]);
    for (let e = 0; e < 8; e += 1) {
      if (L === 0 && e % 2) continue;
      const lift = k.barInChord === 1 && e >= 4 ? 1 : 0;
      k.add(
        "seq",
        ext[(pat[e] as number) + lift] as number,
        k.step(e) + k.hum() * 0.3,
        0.5,
        e % 4 === 0 ? 0.8 : e % 2 === 0 ? 0.62 : 0.5,
        e % 2 ? 0.3 : -0.3,
      );
    }
    const b = k.bass(38);
    if (L === 0) {
      if (k.newChord) k.add("sub", b, 0, k.chordBars * 4 - 0.6, 0.8);
    } else {
      k.add("bass", b, 0, 1.6, 0.9);
      k.add("bass", b, k.step(4), 1.4, 0.75);
      if (k.chance(0.35)) k.add("bass", b + 7, k.step(7), 0.4, 0.5);
    }
    if (k.on("kick")) {
      k.add("kick", 0, 0, 0.4, 0.9);
      k.add("kick", 0, k.step(4), 0.4, 0.7);
    }
    if (k.on("tick"))
      for (const e of [1, 3, 5, 7])
        k.add("tick", 0, k.step(e) + k.hum(), 0.05, e === 3 || e === 7 ? 0.8 : 0.55);
    pings(k, "star", { p: 0.07 * k.layers.star + 0.01, lo: 84, hi: 96, vel: [0.03, 0.045] });
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("lead", {
        voice: "lead",
        form: "AB-AC---",
        center: 76,
        pent: true,
        vel: 0.8,
        legato: 0.95,
        tail: 0.4,
        rhythms: [
          [
            [0, 3],
            [3, 1],
            [4, 4],
          ],
          [
            [0, 4],
            [4, 2],
            [6, 2],
          ],
          [
            [0, 6],
            [6, 2],
          ],
          [
            [2, 2],
            [4, 4],
          ],
        ],
      });
  },
};
