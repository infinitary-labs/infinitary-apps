import { AMBIENT_STYLES, type AmbientStyle } from "@shared/preferences";
import { describe, expect, it } from "vitest";
import { type Bar, Composer, type CrewLevel, crewLevel, type Note, pitchClass } from "./composer";
import type { Style } from "./player";
import { STYLES } from "./styles/catalog";

// The approved ambient music plan (INF-4741, the builder's spec "Tests"),
// held for each of the styles the captain kept (INF-5056, INF-4749): every note in
// the style's key, idle bars hold no drums, a waiting card brings the chime
// at most once every two bars, a merge resolves through the style's cadence,
// and one seed gives the same bars.

const UNPITCHED = new Set(["drum", "wood", "tick"]);
const DRUM_BUSES = new Set(["kick", "rim", "tick"]);

/** Whether a note is a drum: one the style plays on a drum, a wood block or a shaker. */
const isDrum = (style: Style, note: Note) => UNPITCHED.has(style.voices[note.voice]?.[0] ?? "");

/** Bars at a crew level that moves as a session's crew does: idle, one, three, idle. */
function session(style: Style, seed: number): Bar[] {
  const composer = new Composer(style, seed);
  const levels: CrewLevel[] = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0];
  return levels.map((level) => composer.bar(level));
}

/** The pitch classes a bar may sound: the style's scale, and its chord's raised or lowered notes. */
function inKey(style: Style, bar: Bar): Set<number> {
  const pcs = new Set(style.scale.map((step) => pitchClass(style.tonic + step)));
  const chord = style.chords[bar.chord];
  const composer = new Composer(style, 1);
  for (const [i, by] of Object.entries(chord?.x ?? {})) {
    const degree = (chord?.d ?? 0) + (chord?.t[Number(i)] ?? 0);
    pcs.add(pitchClass(style.tonic + composer.deg(degree) + by));
  }
  return pcs;
}

const EACH: [AmbientStyle, Style][] = AMBIENT_STYLES.map((id) => [id, STYLES[id]]);

describe.each(EACH)("the ambient music's composer playing %s", (_id, style) => {
  it("plays every pitched note and the pad in key, across many sessions", () => {
    const scale = new Set(style.scale.map((step) => pitchClass(style.tonic + step)));
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const bar of session(style, seed)) {
        const key = inKey(style, bar);
        const pitched = bar.notes.filter((note) => !isDrum(style, note));
        for (const midi of [...pitched.map((note) => note.midi), ...bar.pad])
          expect(key.has(pitchClass(midi)), `${midi} in bar ${bar.index} on ${bar.chord}`).toBe(
            true,
          );
      }
      const composer = new Composer(style, seed);
      for (const note of [...(composer.waiting(0) ?? []), ...composer.merged()])
        expect(scale.has(pitchClass(note.midi)), `${note.voice} ${note.midi}`).toBe(true);
    }
  });

  it("holds no drums or tune while nobody works, after the bar a leaving pulse plays out", () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const composer = new Composer(style, seed);
      const bars = [2, 2, 0, 0, 0, 0].map((level) => composer.bar(level as CrewLevel));
      for (const bar of bars.slice(2))
        for (const layer of DRUM_BUSES) expect(bar.layers[layer as "kick"]).toBe(0);
      for (const bar of bars.slice(3)) {
        expect(bar.notes.filter((note) => isDrum(style, note))).toEqual([]);
        expect(bar.layers.lead).toBe(0);
      }
      // A session that starts idle starts with no drums at all.
      const first = new Composer(style, seed).bar(0);
      expect(first.notes.filter((note) => isDrum(style, note))).toEqual([]);
    }
  });

  it("warms up as more of the crew works", () => {
    expect([0, 1, 2, 3, 5].map(crewLevel)).toEqual([0, 1, 1, 2, 2]);
    const heat = ([0, 1, 2] as const).map((level) => style.levels[level].heat);
    expect(heat).toEqual([...heat].sort((a, b) => a - b));
    expect(heat[2]).toBeGreaterThan(heat[0] as number);
  });

  it("gives the waiting chime at most once every two bars", () => {
    const composer = new Composer(style, 5);
    const chime = composer.waiting(4) as Note[];
    expect(chime.map((note) => note.voice)).toEqual(["chime", "chime", "chime", "glow"]);
    expect(composer.waiting(4)).toBeNull();
    expect(composer.waiting(5)).toBeNull();
    expect(composer.waiting(6)).not.toBeNull();
  });

  it("steers the next chords through the style's cadence after a merge, with rising sparks", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const composer = new Composer(style, seed);
      composer.bar(1);
      composer.bar(1);
      const sparks = composer.merged();
      expect(sparks.every((note) => note.voice === "spark")).toBe(true);
      expect(sparks.map((note) => note.midi)).toEqual(
        [...sparks.map((note) => note.midi)].sort((a, b) => a - b),
      );
      expect(style.cadence.map(() => composer.bar(2).chord)).toEqual(style.cadence);
    }
  });

  it("composes the same bars from the same seed, and other bars from another", () => {
    expect(session(style, 42)).toEqual(session(style, 42));
    expect(session(style, 42)).not.toEqual(session(style, 43));
  });
});
