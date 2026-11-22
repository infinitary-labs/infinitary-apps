// The piano style (docs/ambient-music.md): Cold sleep, mostly piano and
// futuristic in the way recent science-fiction film scores are - a cold
// felt piano in a very large room, over a low synth drone, with glass and a
// slow pulse around it. The captain kept it from four prototypes (INF-4749)
// and set its tone darker, and soft wind moves through its room (INF-5569).
// No melody, chord walk or sound is taken from any film: it is written
// here from the shipped kit.

import type { BarContext } from "../composer";
import type { PianoPreset } from "../instruments";
import type { Style } from "../player";
import { AEOLIAN, DRUM, GLASS, HELD, layers, PADS, PENT_MINOR, pings, triads } from "./kit";

/** The pianos: a soft felt upright, and a cold, brighter one for the answers and the cues. */
export const PIANO = {
  felt: {
    amp: 0.2,
    bright: 5.5,
    dark: 1.7,
    close: 0.55,
    prompt: 0.85,
    ring: 5.5,
    sing: 0.42,
    beat: 2.6,
    strike: 0.16,
    att: 0.008,
    damp: 0.3,
  },
  cold: {
    amp: 0.17,
    bright: 13,
    dark: 3.6,
    close: 0.9,
    prompt: 0.6,
    ring: 4.2,
    sing: 0.5,
    beat: 3.4,
    strike: 0.22,
    att: 0.005,
    damp: 0.4,
  },
} satisfies Record<string, PianoPreset>;

/** A left hand: the chord's root low, its octave above, held through the chord. */
function lowHand(k: BarContext, voice: string, lo: number, vel: number, octave = 0.62): void {
  if (!k.newChord) return;
  const root = k.bass(lo);
  const length = k.chordBars * k.s.beats + 2;
  k.add(voice, root, k.hum(), length, vel, -0.25);
  if (octave > 0) k.add(voice, root + 12, 0.04 + k.hum(), length, vel * octave, -0.15);
}

/**
 * Cold sleep: a felt piano alone in a very large, cold room, over a low
 * drone. With the crew working a slow heartbeat and a broken chord come
 * in; with three or more, a high answer and a little glass.
 */
export const COLD_SLEEP: Style = {
  bpm: 54,
  beats: 4,
  grid: 2,
  swing: 0,
  hold: 2,
  tonic: 4,
  scale: AEOLIAN,
  pent: PENT_MINOR,
  chords: triads([
    ["i", 0, [0, 2, 4, 8]],
    ["VI", 5, [0, 2, 4, 6]],
    ["iv", 3, [0, 2, 4, 8]],
    ["III", 2, [0, 2, 4, 6]],
    ["VII", 6, [0, 2, 4, 1]],
    ["v", 4, [0, 2, 4, 6]],
  ]),
  start: "i",
  next: {
    i: ["VI", "iv", "VI", "III"],
    VI: ["i", "III", "iv"],
    iv: ["i", "VI", "v"],
    III: ["VII", "VI", "iv"],
    VII: ["i", "i", "VI"],
    v: ["i", "VI"],
  },
  cadence: ["VII", "i"],
  keys: { lo: 55, hi: 76, c: [60, 66], start: [59, 64, 67, 71] },
  pad: { timbre: PADS.ice, anchors: [40, 52, 59], amp: 0.03, glide: 0.8, drift: [[0.11, 5]] },
  wind: 0.6,
  reverb: 4.2,
  wet: 0.85,
  buses: {
    keys: [5200, 0.75, 0],
    arp: [3600, 0.7, 0],
    lead: [7000, 0.9, 0],
    bass: [240, 0.1, 0],
    kick: [300, 0.05, 0],
    star: [9000, 1.1, 0],
    pad: [900, 0.6, 0],
  },
  gains: { pad: -4.5, keys: 5, arp: 2, lead: 7, bass: -2.5, kick: -3.5, star: 6 },
  trim: 0.3,
  // The captain's tone, 60% of the prototype's: 6 dB darker above 1.4 kHz.
  tilt: -6,
  levels: {
    0: { heat: 0, layers: layers(1, 1, 0.7, 0, 0, 0, 0, 0.35, 0) },
    1: { heat: 0.35, layers: layers(0.9, 1, 0.8, 0.45, 0, 0, 0, 0.45, 0.7) },
    2: { heat: 0.7, layers: layers(0.85, 1, 0.85, 0.55, 0, 0, 0.75, 0.6, 0.85) },
  },
  voices: {
    piano: ["piano", "keys", PIANO.felt],
    low: ["piano", "keys", PIANO.felt],
    broken: ["piano", "arp", PIANO.felt],
    high: ["piano", "lead", PIANO.cold],
    sub: ["sus", "bass", HELD.sub],
    beat: ["drum", "kick", DRUM.deep],
    star: GLASS,
    chime: ["piano", "cue", PIANO.cold],
    spark: ["glass", "cue", null],
  },
  cue: { vel: 0.5, ring: 3.2, gain: [0, 0] },
  compose(k) {
    const L = k.level;
    lowHand(k, "low", 28, 0.5);
    if (k.newChord) k.add("sub", k.bass(28), 0, k.chordBars * 4 - 0.4, 0.75);
    if (!k.resolved)
      k.tune("rh", {
        voice: "piano",
        form: L === 0 ? "A-B-A-C-" : "ABA-ACB-",
        center: 71,
        vel: 0.5,
        legato: 1,
        tail: 5,
        vary: 0.12,
        pan: 0.15,
        rhythms: [
          [
            [0, 2],
            [2, 2],
            [4, 4],
          ],
          [
            [0, 3],
            [3, 1],
            [4, 4],
          ],
          [
            [0, 6],
            [6, 2],
          ],
          [
            [2, 2],
            [4, 4],
          ],
          [[0, 8]],
        ],
        starts: [2, 4, 7],
        moves: [-2, -1, -1, 1, 2, 3],
      });
    if (k.on("arp")) {
      const v = k.voicing;
      const order = k.barInChord % 2 ? [1, 2, 3] : [0, 2, 1];
      for (const [i, e] of [0, 3, 6].entries())
        k.add(
          "broken",
          (v[order[i] as number] as number) - 12,
          k.step(e) + k.hum(),
          5,
          0.42 - i * 0.05,
          -0.3 + i * 0.2,
        );
    }
    if (k.on("kick")) {
      k.add("beat", 0, 0, 0.5, 0.8);
      k.add("beat", 0, 0.42, 0.5, 0.45);
    }
    if (k.layers.lead > 0 && !k.resolved)
      k.tune("hi", {
        voice: "high",
        form: "-A--B--A",
        share: "rh",
        center: 83,
        vel: 0.42,
        legato: 1,
        tail: 4,
        pan: -0.35,
        rhythms: [
          [
            [0, 4],
            [4, 4],
          ],
          [[2, 6]],
          [[0, 8]],
        ],
      });
    pings(k, "star", {
      p: 0.035 * k.layers.star,
      lo: 86,
      hi: 96,
      vel: [0.025, 0.04],
      pool: k.tones.slice(0, 3),
      len: 4,
    });
  },
};
