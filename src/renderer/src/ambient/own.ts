// A person's own style read into the engine's style (docs/ambient-music.md,
// "Your own styles"). The style is settings the app checked
// (src/shared/ambientOwn.ts), never code: each part kind here is one fixed
// way of writing notes, and the composer, player and instruments play the
// result as they play a shipped style.

import type { OwnPart, OwnStyle } from "@shared/ambientOwn";
import {
  type BarContext,
  type Bus,
  type Chord,
  type CrewLevel,
  clamp,
  LAYERS,
  type Layer,
} from "./composer";
import type { Style, Voice } from "./player";
import { STYLES } from "./styles/catalog";
import {
  AEOLIAN,
  DORIAN,
  LYDIAN,
  MAJOR,
  PADS,
  PENT_MAJOR,
  PENT_MINOR,
  pings,
  strum,
} from "./styles/kit";
import { paletteVoice } from "./styles/palette";

/** Each scale, and the five-note scale its tunes step along. */
const SCALES: Record<NonNullable<OwnStyle["scale"]>, { scale: number[]; pent: number[] }> = {
  lydian: { scale: LYDIAN, pent: PENT_MAJOR },
  major: { scale: MAJOR, pent: PENT_MAJOR },
  mixolydian: { scale: [0, 2, 4, 5, 7, 9, 10], pent: PENT_MAJOR },
  dorian: { scale: DORIAN, pent: PENT_MINOR },
  minor: { scale: AEOLIAN, pent: PENT_MINOR },
  phrygian: { scale: [0, 1, 3, 5, 7, 8, 10], pent: PENT_MINOR },
};
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** The loudness the app measured for a style: each bus's level and the whole mix's, in dB. */
export type Balance = { gains: Partial<Record<Bus, number>>; trim: number };

type Pitch = number | string;
type When = NonNullable<OwnPart["when"]>;

function pitchOf(k: BarContext, p: Pitch, bassLow: number): number {
  if (typeof p === "number") return p;
  const m = /^(bass|v(\d)|t(\d)@(\d+))([+-]\d+)?$/.exec(p);
  if (!m) return 60;
  const offset = m[5] ? Number(m[5]) : 0;
  if (m[1] === "bass") return k.bass(bassLow) + offset;
  if (m[2] !== undefined) return (k.voicing[Number(m[2]) % k.voicing.length] as number) + offset;
  const tone = k.tones[Number(m[3]) % k.tones.length] as number;
  return k.near(Number(m[4]), [tone]) + offset;
}

function passes(k: BarContext, w: When | undefined): boolean {
  if (!w) return true;
  if (w.levels && !w.levels.includes(k.level)) return false;
  if (w.layer && !k.on(w.layer)) return false;
  if (w.bar && (k.barInChord % 2 === 0) !== (w.bar === "even")) return false;
  if (w.newChord && !k.newChord) return false;
  if (w.playing && !(k.layers[w.playing] > 0)) return false;
  if (w.chance !== undefined && !k.chance(w.chance)) return false;
  return true;
}

/** The compose function for a style's parts: each kind one fixed way of writing a bar's notes. */
function composeFrom(parts: OwnPart[], bassLow: number): (k: BarContext) => void {
  return (k) => {
    parts.forEach((part, i) => {
      if (!passes(k, part.when)) return;
      switch (part.part) {
        case "hold":
          if (k.newChord)
            k.add(
              part.voice,
              pitchOf(k, part.pitch, bassLow),
              k.hum(),
              Math.max(0.25, k.chordBars * k.s.beats + (part.extra ?? -0.6)),
              part.vel,
              part.pan ?? 0,
            );
          break;
        case "steps":
          for (const [step, pitch, vel, len] of part.hits) {
            const midi = pitchOf(k, pitch, bassLow);
            k.add(
              part.voice,
              midi,
              k.step(step) + k.hum(),
              len ?? 1,
              vel * (0.92 + k.rand() * 0.16),
              part.pan ?? (midi ? clamp((midi - 64) / 16, -0.5, 0.5) : 0),
            );
          }
          break;
        case "pattern": {
          // Remembered by the part's place, so a chord keeps one order.
          const memo = k.memo as Record<string, number[]>;
          const key = `own${i}`;
          if (k.newChord || !memo[key]) memo[key] = k.pick(part.orders);
          const order = memo[key] as number[];
          const v = k.voicing;
          const ext = v.concat(v.map((x) => x + 12));
          const steps = part.steps ?? Array.from({ length: k.steps }, (_, e) => e);
          steps.forEach((e, n) => {
            const midi = ext[(order[n % order.length] as number) % ext.length] as number;
            k.add(
              part.voice,
              midi,
              k.step(e) + k.hum() * 0.5,
              part.len,
              part.accents[n % part.accents.length] as number,
              (n % 2 ? 1 : -1) * (part.spread ?? 0.3),
            );
          });
          break;
        }
        case "strum":
          for (const [step, vel] of part.hits)
            strum(k, part.voice, step, part.top ? k.voicing.slice(-part.top) : k.voicing, {
              up: part.up,
              spread: part.spread,
              len: part.len,
              vel,
            });
          break;
        case "pings":
          pings(k, part.voice, {
            p: part.p * k.layers[part.layer],
            lo: part.lo,
            hi: part.hi,
            vel: part.vel,
            pool: part.pool === "chord" ? k.tones.slice(0, 3) : undefined,
            len: part.len,
          });
          break;
        case "tune":
          if (!k.resolved)
            k.tune(part.id, {
              ...part.tune,
              form: part.forms?.[String(k.level) as "0" | "1" | "2"] ?? part.tune.form,
            });
          break;
      }
    });
  };
}

/**
 * The engine's style for a checked own style, at the loudness the app
 * measured for it. What the style leaves out comes from the shipped style
 * it starts from (`like`); a style that brings its own voices takes none of
 * that style's levels, since the balance measured its own.
 */
export function styleFromOwn(own: OwnStyle, balance: Balance = { gains: {}, trim: 0 }): Style {
  const base: Style | undefined = own.like ? STYLES[own.like] : undefined;
  const need = <T>(value: T | undefined, from: T | undefined, field: string): T => {
    const v = value ?? from;
    if (v === undefined) throw new Error(`The style gives no ${field}`);
    return v;
  };
  const sc = own.scale ? SCALES[own.scale] : undefined;
  const tonic = own.key ? KEYS.indexOf(own.key) : undefined;
  // A shipped style's parts may read a chord's fourth tone: a shorter chord
  // a person's style brings is filled with its root an octave up.
  const fill = !own.parts;
  const chords = own.chords
    ? Object.fromEntries(
        own.chords.map((c) => {
          const t = (c.tones ?? [0, 2, 4]).slice();
          while (fill && t.length < 4) t.push(7);
          const chord: Chord = { d: c.degree, t };
          if (c.bass !== undefined) chord.b = c.bass;
          if (c.hold !== undefined) chord.hold = c.hold;
          return [c.name, chord];
        }),
      )
    : undefined;
  const voices = own.voices
    ? Object.fromEntries(
        Object.entries(own.voices).map(([name, v]) => [
          name,
          paletteVoice(v.instrument, v.bus, v.preset, v.db),
        ]),
      )
    : undefined;
  const levels = own.levels
    ? (Object.fromEntries(
        own.levels.map((lv, L) => [
          L,
          {
            heat: lv.heat,
            layers: Object.fromEntries(LAYERS.map((n) => [n, lv.layers[n] ?? 0])) as Record<
              Layer,
              number
            >,
          },
        ]),
      ) as Style["levels"])
    : undefined;
  const pad = own.pad
    ? {
        timbre: PADS[own.pad.timbre],
        anchors: own.pad.anchors,
        amp: own.pad.amp,
        ...(own.pad.glide === undefined ? {} : { glide: own.pad.glide }),
        ...(own.pad.dip === undefined ? {} : { dip: own.pad.dip }),
        ...(own.pad.swell === undefined ? {} : { swell: own.pad.swell }),
        ...(own.pad.tide === undefined ? {} : { tide: own.pad.tide }),
        ...(own.pad.drift === undefined ? {} : { drift: own.pad.drift }),
        ...(own.pad.wobble === undefined ? {} : { wobble: own.pad.wobble }),
      }
    : undefined;
  const inherits = base && !own.voices;
  const gains: Partial<Record<Bus, number>> = { ...(inherits ? base.gains : {}), ...balance.gains };
  for (const [bus, db] of Object.entries(own.mix ?? {}))
    gains[bus as Bus] = (gains[bus as Bus] ?? 0) + (db as number);
  const hands = own.hands
    ? { lo: own.hands.lo, hi: own.hands.hi, c: own.hands.center, start: own.hands.start }
    : undefined;
  const room = own.room;
  return {
    bpm: need(own.bpm, base?.bpm, "bpm"),
    beats: need(own.beats, base?.beats, "beats"),
    grid: need(own.grid, base?.grid, "grid"),
    swing: own.swing ?? base?.swing ?? 0,
    hold: need(own.hold, base?.hold, "hold"),
    tonic: need(tonic, base?.tonic, "key"),
    scale: need(sc?.scale, base?.scale, "scale"),
    pent: need(sc?.pent, base?.pent, "scale"),
    chords: need(chords, base?.chords, "chords"),
    start: need(own.start, base?.start, "start"),
    next: need(own.next, base?.next, "next"),
    cadence: need(own.cadence, base?.cadence, "cadence"),
    keys: need(hands, base?.keys, "hands"),
    pad: need(pad as Style["pad"] | undefined, base?.pad, "pad"),
    reverb: need(room?.reverb, base?.reverb, "room"),
    wet: need(room?.wet, base?.wet, "room"),
    ...(room ? (room.echo ? { echo: room.echo } : {}) : base?.echo ? { echo: base.echo } : {}),
    buses: { ...(base?.buses ?? {}), ...(own.buses ?? {}) },
    gains,
    trim: (inherits ? base.trim : 0) + balance.trim,
    ...((own.tone ?? base?.tilt) === undefined ? {} : { tilt: own.tone ?? base?.tilt }),
    sea: own.sea ?? base?.sea ?? false,
    rain: own.rain ?? base?.rain ?? 0,
    wind: own.wind ?? base?.wind ?? 0,
    levels: need(levels, base?.levels, "levels"),
    voices: need(voices, base?.voices, "voices") as Record<string, Voice>,
    cue: need(own.cue, base?.cue, "cue"),
    compose: own.parts
      ? composeFrom(own.parts, own.bassLow ?? 38)
      : need(base?.compose, undefined, "parts"),
  };
}

/** Whether a style needs each layer balanced: it brings its own voices. */
export function ownNeedsBalance(own: OwnStyle): boolean {
  return own.voices !== undefined;
}

/** The crew level where a layer plays loudest, so its measure hears it. */
export function loudestLevel(style: Style, layer: Layer): CrewLevel | null {
  let best: CrewLevel | null = null;
  for (const L of [2, 1, 0] as CrewLevel[])
    if (style.levels[L].layers[layer] > (best === null ? 0 : style.levels[best].layers[layer]))
      best = L;
  return best;
}
