import {
  OWN_INSTRUMENTS,
  type OwnStyle,
  ownStyleFaults,
  ownStyleSchema,
  SHIPPED_STYLE_FACTS,
} from "@shared/ambientOwn";
import { AMBIENT_STYLES } from "@shared/preferences";
import { describe, expect, it } from "vitest";
import { type Bar, Composer, type CrewLevel, pitchClass } from "./composer";
import { styleFromOwn } from "./own";
import bossa from "./own-samples/bossa.json";
import bowls from "./own-samples/bowls.json";
import hardTechno from "./own-samples/hard-techno.json";
import lofi from "./own-samples/lofi.json";
import warmSleep from "./own-samples/warm-sleep.json";
import type { Style } from "./player";
import { STYLES } from "./styles/catalog";
import { PALETTE } from "./styles/palette";

// The approved plan for a person's own ambient styles (INF-5541, "Tests"):
// the reader and the check, held on four styles the first mate wrote from
// a person's words while the plan was made - lofi beats, singing bowls, a
// bossa nova, and Cold sleep made warmer - each played at every crew level
// with the waiting chime and merge sparks, and a faulty style refused in
// words.

const SAMPLES: [string, unknown][] = [
  ["lofi beats", lofi],
  ["singing bowls", bowls],
  ["bossa nova", bossa],
  ["Cold sleep made warmer", warmSleep],
  ["hard techno, pump up music", hardTechno],
];

const UNPITCHED = new Set(["drum", "wood", "tick"]);

/** Bars at a crew level that moves as a session's crew does: idle, one, three, idle. */
function session(style: Style, seed: number): Bar[] {
  const composer = new Composer(style, seed);
  const levels: CrewLevel[] = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0];
  return levels.map((level) => composer.bar(level));
}

describe.each(SAMPLES)("a person's own style: %s", (_name, sample) => {
  const own = ownStyleSchema.parse(sample);
  const style = styleFromOwn(own);

  it("passes the check", () => {
    expect(ownStyleFaults(own)).toEqual([]);
  });

  it("plays in key at every crew level, and each part's voice is one the style defines", () => {
    const scale = new Set(style.scale.map((step) => pitchClass(style.tonic + step)));
    const levelsHeard = new Set<number>();
    for (let seed = 1; seed <= 20; seed += 1)
      for (const bar of session(style, seed)) {
        levelsHeard.add(bar.level);
        for (const note of bar.notes) {
          const voice = style.voices[note.voice];
          expect(voice, note.voice).toBeDefined();
          if (!UNPITCHED.has(voice?.[0] ?? "") && !style.chords[bar.chord]?.x)
            expect(scale.has(pitchClass(note.midi)), `${note.voice} ${note.midi}`).toBe(true);
        }
      }
    expect([...levelsHeard].sort()).toEqual([0, 1, 2]);
  });

  it("plays more as more of the crew works", () => {
    const busy = (level: CrewLevel) =>
      Object.values(style.levels[level].layers).filter((on) => on > 0).length;
    expect(busy(2)).toBeGreaterThan(busy(0));
  });

  it("gives the waiting chime and the merge sparks", () => {
    const composer = new Composer(style, 3);
    composer.bar(1);
    expect(composer.waiting(1)?.some((note) => note.voice === "chime")).toBe(true);
    expect(composer.merged().every((note) => note.voice === "spark")).toBe(true);
    expect(composer.merged().length).toBeGreaterThan(0);
  });
});

// A person's report: asking for "hard techno, pump up music" froze the window,
// and every launch after stayed black, because the first mate's style gave
// the pad two notes and the composer looked for a third that never came.
describe("a person's own pad with any number of notes the check accepts", () => {
  it.each([1, 2, 3, 4])("plays one note on each of %i pad voices", (count) => {
    const own = ownStyleSchema.parse(hardTechno);
    if (!own.pad) throw new Error("the hard techno sample has a pad");
    own.pad.anchors = [33, 45, 52, 57].slice(0, count);
    expect(ownStyleFaults(own)).toEqual([]);
    const composer = new Composer(styleFromOwn(own), 7);
    for (const level of [0, 1, 2, 2, 1, 0] as CrewLevel[]) {
      const { pad } = composer.bar(level);
      expect(pad).toHaveLength(count);
      for (const note of pad) expect(Number.isInteger(note)).toBe(true);
    }
  });
});

describe("the check on a person's own style", () => {
  const good = ownStyleSchema.parse(lofi) as OwnStyle;
  const faultsOf = (change: (style: OwnStyle) => void) => {
    const style = structuredClone(good);
    change(style);
    return ownStyleFaults(style);
  };

  it("names a voice a part plays that the style does not define", () => {
    expect(
      faultsOf((s) => {
        delete s.voices?.vibes;
      }),
    ).toEqual(["parts[7] (tune) plays the voice vibes, which voices does not define."]);
  });

  it("names a preset its instrument lacks, with the presets it has", () => {
    const [fault] = faultsOf((s) => {
      if (s.voices?.ep) s.voices.ep.preset = "rhodes";
    });
    expect(fault).toContain("The voice ep names the preset rhodes, which fm lacks");
    expect(fault).toContain(OWN_INSTRUMENTS.fm.join(", "));
  });

  it("names a step past the bar, and a chord the progression never defines", () => {
    expect(
      faultsOf((s) => {
        s.beats = 3;
      }),
    ).toEqual([
      "parts[5] (steps) plays a step past the bar's last, 5 (3 beats of 2).",
      "parts[6] (steps) plays a step past the bar's last, 5 (3 beats of 2).",
      "parts[7] (tune) has a rhythm step past the bar's last, 5.",
    ]);
    expect(
      faultsOf((s) => {
        s.start = "IV";
      }),
    ).toEqual(["start names the chord IV, which chords does not define."]);
  });

  it("refuses a style missing the chime or spark, and one asking for too many notes", () => {
    expect(
      faultsOf((s) => {
        delete s.voices?.spark;
      }),
    ).toEqual(["voices needs spark, which plays a cue on the cue bus."]);
    const [fault] = faultsOf((s) => {
      for (let i = 0; i < 12; i += 1) s.parts?.push(structuredClone(s.parts[6] as never));
    });
    expect(fault).toMatch(/^The parts ask for up to \d+ notes a bar; keep it to 96/);
  });
});

describe("what a person's style can start from and play", () => {
  it("knows each shipped style's bar and voices as the style plays them", () => {
    for (const id of AMBIENT_STYLES) {
      const shipped = STYLES[id];
      expect(SHIPPED_STYLE_FACTS[id], id).toEqual({
        beats: shipped.beats,
        grid: shipped.grid,
        voices: Object.keys(shipped.voices),
      });
    }
  });

  it("has a sound for every preset the check accepts", () => {
    for (const [instrument, presets] of Object.entries(OWN_INSTRUMENTS))
      expect(Object.keys(PALETTE[instrument as keyof typeof PALETTE]).sort(), instrument).toEqual(
        [...presets].sort(),
      );
  });
});

// INF-5569's approved answer: soft rain or wind only where it improves a
// shipped style - Tavern embers rain at 50%, Cold sleep wind at 60%, and
// Moonlit deck wind at 60% (the captain's own amount) - and a person's
// own style started from one of them keeps it.
describe("rain and wind in the shipped styles", () => {
  it("plays rain in Tavern embers alone, and wind in Cold sleep and Moonlit deck alone", () => {
    const heard = Object.fromEntries(
      AMBIENT_STYLES.filter((id) => STYLES[id].rain || STYLES[id].wind).map((id) => [
        id,
        { rain: STYLES[id].rain ?? 0, wind: STYLES[id].wind ?? 0 },
      ]),
    );
    expect(heard).toEqual({
      "cold-sleep": { rain: 0, wind: 0.6 },
      "tavern-embers": { rain: 0.5, wind: 0 },
      "moonlit-deck": { rain: 0, wind: 0.6 },
    });
    expect(STYLES["tavern-embers"].sea).toBe(true);
  });

  it("keeps a shipped style's rain or wind in a person's style started from it, unless the style sets its own", () => {
    const warm = styleFromOwn(ownStyleSchema.parse(warmSleep));
    expect(warm.wind).toBe(STYLES["cold-sleep"].wind);
    const still = styleFromOwn(ownStyleSchema.parse({ ...warmSleep, wind: 0 }));
    expect(still.wind).toBe(0);
  });
});
