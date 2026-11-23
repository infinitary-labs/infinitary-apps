// A person's own ambient music styles (docs/ambient-music.md, "Your own
// styles"): a style the first mate writes from someone's words, as settings
// for the app's own instruments, never code. The window reads it into the
// engine's own style (src/renderer/src/ambient/own.ts) and balances its
// loudness against the shipped styles; this module is the format, its
// check and the names both sides share.

import { z } from "zod";
import { AMBIENT_STYLES, type AmbientStyle } from "./ambientStyles";

/** How long one saved style may be, in characters of JSON. */
export const OWN_STYLE_CHARS_MAX = 8_000;
/**
 * How many notes one bar may ask for at most, counted from its parts: a
 * shipped style's busiest bar asks for under 50, and the player schedules a
 * bar about a second ahead, so a bar must stay cheap to compose and play.
 */
export const OWN_STYLE_NOTES_MAX = 96;

/** Keys, by the name of their home note. */
export const OWN_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
/** Scales, from brightest to darkest. */
export const OWN_SCALES = ["lydian", "major", "mixolydian", "dorian", "minor", "phrygian"] as const;
/** The pad's timbres. */
export const OWN_PADS = ["ice", "strings", "reed", "horns", "choir", "drone"] as const;
/** The layers whose loudness follows the crew, as the engine names them. */
export const OWN_LAYERS = [
  "pad",
  "keys",
  "bass",
  "kick",
  "rim",
  "tick",
  "lead",
  "star",
  "arp",
] as const;
/** A layer, or the cues' own bus, where the waiting chime and the merge sparks play. */
export const OWN_BUSES = [...OWN_LAYERS, "cue"] as const;

/**
 * Each instrument and its presets, the first the one it plays when none is
 * named. The window holds the sounds (src/renderer/src/ambient/styles/palette.ts).
 */
export const OWN_INSTRUMENTS = {
  piano: ["felt", "cold"],
  fm: ["ep", "celesta", "chime"],
  pluck: ["guitar", "harp", "uke", "lute", "pizz", "seq", "upright"],
  mallet: ["marimba", "vibes", "kalimba", "musicbox", "bell", "handbell", "sonar", "bowl"],
  sus: [
    "flute",
    "whistle",
    "noseflute",
    "theremin",
    "synthLead",
    "fiddle",
    "reedLead",
    "bugle",
    "conch",
    "sub",
  ],
  bass: ["round"],
  drum: ["kick", "frame", "pahu", "field", "deep"],
  wood: ["tap", "pate"],
  tick: ["soft", "shaker"],
  glass: ["glass"],
} as const;
export type OwnInstrument = keyof typeof OWN_INSTRUMENTS;
const INSTRUMENT_NAMES = Object.keys(OWN_INSTRUMENTS) as [OwnInstrument, ...OwnInstrument[]];

/**
 * What a shipped style a person's style starts from (`like`) brings: its
 * bar's beats and grid steps, and its voices, which its own parts play. The
 * window's test holds these to the shipped styles themselves.
 */
export const SHIPPED_STYLE_FACTS: Record<
  AmbientStyle,
  { beats: number; grid: number; voices: readonly string[] }
> = {
  "deep-drift": { beats: 4, grid: 2, voices: ["sub", "ping", "arp", "lead", "chime", "spark"] },
  "star-cruise": {
    beats: 4,
    grid: 2,
    voices: ["sub", "bass", "kick", "tick", "seq", "lead", "star", "chime", "spark"],
  },
  "cold-sleep": {
    beats: 4,
    grid: 2,
    voices: ["piano", "low", "broken", "high", "sub", "beat", "star", "chime", "spark"],
  },
  "quiet-cove": {
    beats: 2,
    grid: 3,
    voices: ["lute", "bass", "frame", "tap", "lead", "glint", "chime", "spark"],
  },
  "tavern-embers": {
    beats: 3,
    grid: 2,
    voices: ["pizz", "lute", "bass", "frame", "tap", "lead", "box", "chime", "spark"],
  },
  "moonlit-deck": {
    beats: 4,
    grid: 2,
    voices: ["harp", "sub", "deep", "lead", "box", "chime", "spark"],
  },
  "harbor-dawn": {
    beats: 4,
    grid: 2,
    voices: ["harp", "sub", "bass", "field", "lead", "bell", "chime", "spark"],
  },
  "fair-winds": {
    beats: 4,
    grid: 2,
    voices: ["guitar", "bass", "frame", "tap", "call", "answer", "chime", "spark"],
  },
  "wayfinder-night": {
    beats: 4,
    grid: 2,
    voices: ["kalimba", "sub", "bass", "pahu", "lead", "conch", "star", "chime", "spark"],
  },
  "island-morning": {
    beats: 4,
    grid: 2,
    voices: ["marimba", "bass", "pahu", "pate", "shake", "uke", "lead", "star", "chime", "spark"],
  },
};

const name = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{0,15}$/)
  .describe("A short name of letters and digits");
const layer = z.enum(OWN_LAYERS);
const level = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const step = z
  .number()
  .int()
  .min(0)
  .max(27)
  .describe("A grid step in the bar, from 0; a bar has beats × grid steps");
const vel = z.number().min(0).max(1).describe("How hard, 0-1");
const pan = z.number().min(-1).max(1).describe("-1 left to 1 right");
const pitch = z
  .union([
    z.number().int().min(0).max(108),
    z.string().regex(/^(bass|v[0-4]|t[0-4]@\d{2,3})([+-]\d{1,2})?$/),
  ])
  .describe(
    "A MIDI note; or bass (the chord's root at or above bassLow), v0-v4 (the hands' chord notes, low to high), tN@M (chord tone N nearest MIDI M), each with an optional +n or -n semitones. Drums, wood and ticks ignore pitch: use 0",
  );

const when = z
  .strictObject({
    levels: z.array(level).optional().describe("Plays only at these crew levels"),
    layer: layer.optional().describe("Plays only while this layer sounds"),
    playing: layer.optional().describe("Plays only while this layer is in the level's mix"),
    bar: z.enum(["even", "odd"]).optional().describe("The bar's place in its chord"),
    newChord: z.boolean().optional().describe("Plays only on a chord's first bar"),
    chance: z.number().min(0).max(1).optional().describe("Plays this often, 0-1"),
  })
  .describe("When the part plays; every condition given must hold");

const tune = z.strictObject({
  voice: name,
  form: z
    .string()
    .regex(/^[A-Z-]{1,16}$/)
    .describe("Motif letters walked a bar at a time, - rests, such as A-B-A-C-"),
  center: z.number().int().min(36).max(96).describe("The MIDI note the tune centers on"),
  rhythms: z
    .array(
      z
        .array(z.tuple([step, z.number().int().min(1).max(28)]))
        .min(1)
        .max(8),
    )
    .min(1)
    .max(6)
    .describe("One-bar rhythms as [grid step, length in steps]; each motif takes one"),
  share: name.optional().describe("Another tune's id whose motifs this one answers with"),
  renew: z.number().int().min(1).max(8).optional(),
  starts: z.array(z.number().int().min(-3).max(8)).min(1).max(8).optional(),
  moves: z.array(z.number().int().min(-4).max(4)).min(1).max(12).optional(),
  lo: z.number().int().min(-7).max(14).optional(),
  hi: z.number().int().min(-7).max(14).optional(),
  pent: z.boolean().optional().describe("Steps along the five-note scale"),
  vary: z.number().min(0).max(1).optional(),
  chordOnly: z.boolean().optional(),
  legato: z.number().min(0.1).max(1.5).optional(),
  tail: z.number().min(0).max(4).optional(),
  vel: vel.optional(),
  pan: pan.optional(),
  grace: z.number().min(0).max(1).optional(),
  harm: z.number().int().min(-7).max(7).optional().describe("A second voice this many steps away"),
  harmVoice: name.optional(),
});

const part = z.discriminatedUnion("part", [
  z
    .strictObject({
      part: z.literal("hold"),
      voice: name,
      pitch,
      vel,
      pan: pan.optional(),
      extra: z.number().min(-4).max(4).optional().describe("Beats longer than the chord"),
      when: when.optional(),
    })
    .describe("One note held through each chord"),
  z
    .strictObject({
      part: z.literal("steps"),
      voice: name,
      hits: z
        .array(
          z
            .tuple([step, pitch, vel, z.number().min(0.02).max(16).optional()])
            .describe("[grid step, pitch, how hard, length in beats]"),
        )
        .min(1)
        .max(32),
      pan: pan.optional(),
      when: when.optional(),
    })
    .describe("Notes or drum hits at fixed grid steps, every bar"),
  z
    .strictObject({
      part: z.literal("pattern"),
      voice: name,
      orders: z
        .array(z.array(z.number().int().min(0).max(9)).min(1).max(16))
        .min(1)
        .max(8)
        .describe("Orders through the hands' chord notes, two octaves; one is picked each chord"),
      steps: z
        .array(step)
        .min(1)
        .max(28)
        .optional()
        .describe("Grid steps it plays; all of them if left out"),
      len: z.number().min(0.05).max(8).describe("Each note's length in beats"),
      accents: z.array(vel).min(1).max(16),
      spread: z.number().min(0).max(1).optional(),
      when: when.optional(),
    })
    .describe("A repeating broken chord, an arpeggio"),
  z
    .strictObject({
      part: z.literal("strum"),
      voice: name,
      hits: z
        .array(z.tuple([step, vel]))
        .min(1)
        .max(8)
        .describe("[grid step, how hard]"),
      up: z.boolean().optional().describe("High to low"),
      spread: z.number().min(0).max(0.2).optional().describe("Beats between strings"),
      len: z.number().min(0.05).max(16).optional(),
      top: z.number().int().min(1).max(5).optional().describe("Only the highest this many notes"),
      when: when.optional(),
    })
    .describe("The hands' chord strummed or struck together"),
  z
    .strictObject({
      part: z.literal("pings"),
      voice: name,
      layer: layer.describe("The layer whose loudness scales how often it pings"),
      p: z.number().min(0).max(0.5).describe("Chance on each grid step"),
      lo: z.number().int().min(36).max(108),
      hi: z.number().int().min(36).max(108),
      vel: z.tuple([vel, vel]),
      pool: z.enum(["chord", "pent"]).optional().describe("Chord tones, or the five-note scale"),
      len: z.number().min(0.05).max(16).optional(),
      when: when.optional(),
    })
    .describe("Sparse random high notes"),
  z
    .strictObject({
      part: z.literal("tune"),
      id: name,
      tune,
      forms: z
        .strictObject({
          "0": z
            .string()
            .regex(/^[A-Z-]{1,16}$/)
            .optional(),
          "1": z
            .string()
            .regex(/^[A-Z-]{1,16}$/)
            .optional(),
          "2": z
            .string()
            .regex(/^[A-Z-]{1,16}$/)
            .optional(),
        })
        .optional()
        .describe("Another form at a crew level"),
      when: when.optional(),
    })
    .describe("A melody of remembered motifs that repeat and vary, like a song"),
]);

const levelMix = z.strictObject({
  heat: z.number().min(0).max(1).describe("How warm and open the pad is, 0-1"),
  layers: z
    .partialRecord(layer, z.number().min(0).max(1))
    .describe("Each layer's loudness, 0-1; left out is silent"),
});

/** One person's own style. */
export const ownStyleSchema = z
  .strictObject({
    name: z.string().min(1).max(40).describe("The style's name, which Settings shows"),
    words: z
      .string()
      .max(300)
      .describe("The person's own words for the music, which Settings shows"),
    like: z
      .enum(AMBIENT_STYLES)
      .optional()
      .describe("A shipped style it starts from: every field left out is taken from it"),
    bpm: z.number().min(30).max(160).optional(),
    beats: z.number().int().min(2).max(7).optional().describe("Beats in a bar"),
    grid: z
      .number()
      .int()
      .min(2)
      .max(4)
      .optional()
      .describe("Steps in a beat: 2 eighths, 3 a rocking triplet feel"),
    swing: z.number().min(0).max(0.2).optional().describe("Off-beat eighths pushed late, in beats"),
    hold: z.number().int().min(1).max(8).optional().describe("Bars each chord lasts"),
    key: z.enum(OWN_KEYS).optional(),
    scale: z.enum(OWN_SCALES).optional(),
    chords: z
      .array(
        z.strictObject({
          name,
          degree: z
            .number()
            .int()
            .min(0)
            .max(6)
            .describe("The scale degree it stands on, 0 the home"),
          tones: z
            .array(z.number().int().min(0).max(13))
            .min(2)
            .max(5)
            .optional()
            .describe("Scale steps up from the degree; [0,2,4] a triad, [0,2,4,6] a seventh"),
          bass: z.number().int().min(0).max(6).optional().describe("Another bass degree"),
          hold: z.number().int().min(1).max(8).optional(),
        }),
      )
      .min(1)
      .max(12)
      .optional()
      .describe("Give chords, start, next and cadence together"),
    start: name.optional(),
    next: z
      .record(name, z.array(name).min(1).max(8))
      .optional()
      .describe("Where each chord may go; a repeat is likelier"),
    cadence: z
      .array(name)
      .min(1)
      .max(4)
      .optional()
      .describe("The chords a merge steers home through"),
    hands: z
      .strictObject({
        lo: z.number().int().min(36).max(96),
        hi: z.number().int().min(36).max(96),
        center: z.tuple([z.number().int().min(36).max(96), z.number().int().min(36).max(96)]),
        start: z.array(z.number().int().min(36).max(96)).min(2).max(5),
      })
      .optional()
      .describe(
        "Where the chord notes sit: their range, where their center may move and the first voicing",
      ),
    bassLow: z.number().int().min(24).max(52).optional(),
    pad: z
      .strictObject({
        timbre: z.enum(OWN_PADS),
        anchors: z
          .array(z.number().int().min(24).max(72))
          .min(1)
          .max(4)
          .describe("Each pad voice's lowest note"),
        amp: z.number().min(0).max(0.12),
        glide: z.number().min(0).max(3).optional(),
        dip: z.number().min(0).max(1).optional(),
        swell: z.number().min(0).max(1).optional(),
        tide: z.number().min(0).max(1).optional(),
        drift: z
          .array(z.tuple([z.number().min(0.01).max(2), z.number().min(0).max(20)]))
          .max(3)
          .optional(),
        wobble: z.tuple([z.number().min(0.01).max(2), z.number().min(0).max(400)]).optional(),
      })
      .optional()
      .describe("The long held chord under everything"),
    room: z
      .strictObject({
        reverb: z.number().min(0.3).max(8).describe("Seconds"),
        wet: z.number().min(0).max(1.2),
        echo: z
          .strictObject({
            beats: z.number().min(0.25).max(4),
            fb: z.number().min(0).max(0.7),
            lp: z.number().min(300).max(8000),
            mix: z.number().min(0).max(1),
          })
          .optional(),
      })
      .optional(),
    tone: z
      .number()
      .min(-12)
      .max(6)
      .optional()
      .describe("Darker under 0 or brighter, dB above 1.4 kHz"),
    sea: z.boolean().optional().describe("Soft sea waves under the music"),
    rain: z.number().min(0).max(1).optional().describe("Soft rain under the music, 0-1"),
    wind: z.number().min(0).max(1).optional().describe("Soft wind under the music, 0-1"),
    buses: z
      .partialRecord(
        z.enum(OWN_BUSES),
        z.tuple([
          z.number().min(100).max(11000),
          z.number().min(0).max(1.5),
          z.number().min(0).max(1),
        ]),
      )
      .optional()
      .describe("A bus's [lowpass Hz, send to reverb, send to echo]"),
    voices: z
      .record(
        name,
        z.strictObject({
          instrument: z.enum(INSTRUMENT_NAMES),
          bus: z.enum(OWN_BUSES),
          preset: z.string().max(16).optional().describe("One of the instrument's presets"),
          db: z.number().min(-30).max(24).optional().describe("The voice's own level"),
        }),
      )
      .optional()
      .describe(
        `The voices parts play, by name; chime and spark play the cues, on the cue bus. Instruments and presets: ${Object.entries(
          OWN_INSTRUMENTS,
        )
          .map(([instrument, presets]) => `${instrument} (${presets.join(", ")})`)
          .join("; ")}`,
      ),
    levels: z
      .tuple([levelMix, levelMix, levelMix])
      .optional()
      .describe("The mix with nobody working, one or two crewmates, and three or more"),
    mix: z
      .partialRecord(layer, z.number().min(-60).max(12))
      .optional()
      .describe("A layer louder or quieter than the app's balance, in dB; -60 silences it"),
    cue: z
      .strictObject({
        shift: z.number().int().min(-12).max(12).optional(),
        ring: z.number().min(0.2).max(6).optional(),
        vel: z.number().min(0).max(1).optional(),
        run: z.number().min(0.03).max(0.4).optional(),
        sparkRing: z.number().min(0.2).max(6).optional(),
        sparkVel: z.number().min(0).max(1).optional(),
        gain: z.tuple([z.number().min(-24).max(12), z.number().min(-24).max(12)]),
      })
      .optional()
      .describe(
        "The waiting chime and the merge sparks: their shift, ring, loudness and levels in dB",
      ),
    parts: z.array(part).min(1).max(24).optional().describe("What plays each bar"),
  })
  .describe("A style for the app's own instruments: settings the app checks, never code");
export type OwnStyle = z.infer<typeof ownStyleSchema>;
export type OwnPart = OwnStyle["parts"] extends (infer P)[] | undefined ? P : never;

/** The saved own styles, as the look carries them. */
export const ownStylesSchema = z.array(
  ownStyleSchema.extend({ id: z.string().regex(/^own-[a-z0-9-]{1,36}$/) }),
);
export type SavedOwnStyle = OwnStyle & { id: string };

/** The saved style a name or id names: a name in any case, an id exactly. */
export function findOwnStyle(
  saved: readonly SavedOwnStyle[],
  nameOrId: string,
): SavedOwnStyle | undefined {
  const name = nameOrId.toLowerCase();
  return saved.find((own) => own.id === nameOrId || own.name.toLowerCase() === name);
}

/** What a name no saved style has answers: the saved styles' names, to name one of them. */
export function noOwnStyle(nameOrId: string, saved: readonly SavedOwnStyle[]): string {
  // i18n-exempt: served to the first mate in English
  return `No own style ${nameOrId}. Saved: ${saved.map((own) => own.name).join(", ") || "none"}.`;
}

/** The id a style's name saves under: its own, never a shipped style's, and the same for the same name. */
export function ownStyleId(styleName: string): string {
  const slug = styleName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  if (slug) return `own-${slug}`;
  let hash = 2166136261;
  for (const char of styleName) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return `own-${(hash >>> 0).toString(36)}`;
}

/** Whether a style id names an own style rather than a shipped one. */
export function isOwnStyleId(id: string): boolean {
  return id.startsWith("own-");
}

const REQUIRED_ALONE = [
  "bpm",
  "beats",
  "grid",
  "hold",
  "key",
  "scale",
  "chords",
  "hands",
  "pad",
  "room",
  "voices",
  "levels",
  "cue",
  "parts",
] as const;

/** How many notes a part may ask for in one bar, at most. */
function partNotes(p: OwnPart, steps: number): number {
  switch (p.part) {
    case "hold":
      return 1;
    case "steps":
      return p.hits.length;
    case "pattern":
      return p.steps?.length ?? steps;
    case "strum":
      return p.hits.length * 5;
    case "pings":
      return steps;
    case "tune": {
      const longest = Math.max(...p.tune.rhythms.map((r) => r.length));
      return longest * (1 + (p.tune.harm ? 1 : 0) + (p.tune.grace ? 1 : 0));
    }
  }
}

/**
 * Every fault that would keep a checked style from playing as written, in
 * words the first mate can act on; none means it plays. The schema has
 * already held each value to its range.
 */
export function ownStyleFaults(style: OwnStyle): string[] {
  const faults: string[] = [];
  const base = style.like ? SHIPPED_STYLE_FACTS[style.like] : undefined;
  if (!base)
    for (const field of REQUIRED_ALONE)
      if (style[field] === undefined)
        faults.push(
          // i18n-exempt: a fault served to the first mate in English
          `${field} is missing: a style that starts from no shipped style (like) gives it.`,
        );
  const group = [style.chords, style.start, style.next, style.cadence];
  if (group.some((x) => x !== undefined) && group.some((x) => x === undefined))
    // i18n-exempt: a fault served to the first mate in English
    faults.push("chords, start, next and cadence go together: give all four or none.");
  if (style.chords) {
    const names = new Set(style.chords.map((c) => c.name));
    // i18n-exempt: a fault served to the first mate in English
    if (names.size !== style.chords.length) faults.push("Two chords share a name.");
    const known = (n: string, where: string) => {
      if (!names.has(n))
        // i18n-exempt: a fault served to the first mate in English
        faults.push(`${where} names the chord ${n}, which chords does not define.`);
    };
    if (style.start) known(style.start, "start");
    for (const c of style.chords)
      if (!style.next?.[c.name]?.length)
        // i18n-exempt: a fault served to the first mate in English
        faults.push(`next gives no way on from the chord ${c.name}.`);
    for (const [from, to] of Object.entries(style.next ?? {})) {
      known(from, "next");
      for (const n of to) known(n, `next.${from}`);
    }
    for (const n of style.cadence ?? []) known(n, "cadence");
  }
  if (style.hands) {
    const { lo, hi, center, start } = style.hands;
    // i18n-exempt: a fault served to the first mate in English
    if (lo + 12 > hi) faults.push("hands needs at least an octave from lo to hi.");
    if (center[0] > center[1] || center[0] < lo || center[1] > hi)
      // i18n-exempt: a fault served to the first mate in English
      faults.push("hands.center must sit inside lo to hi, low first.");
    if (start.some((note) => note < lo || note > hi))
      // i18n-exempt: a fault served to the first mate in English
      faults.push("hands.start must sit inside lo to hi.");
  }
  if (style.voices)
    for (const [voice, v] of Object.entries(style.voices)) {
      const presets: readonly string[] = OWN_INSTRUMENTS[v.instrument];
      if (v.preset !== undefined && !presets.includes(v.preset))
        faults.push(
          // i18n-exempt: a fault served to the first mate in English
          `The voice ${voice} names the preset ${v.preset}, which ${v.instrument} lacks; it has ${presets.join(", ")}.`,
        );
    }
  // The voices the parts play: the style's own, or the shipped style's.
  const voices = new Set(style.voices ? Object.keys(style.voices) : (base?.voices ?? []));
  // i18n-exempt: a fault served to the first mate in English
  for (const cue of ["chime", "spark"])
    if (!voices.has(cue)) faults.push(`voices needs ${cue}, which plays a cue on the cue bus.`);
  if (style.voices && !style.parts && base) {
    const missing = base.voices.filter((v) => !voices.has(v));
    if (missing.length > 0)
      faults.push(
        // i18n-exempt: a fault served to the first mate in English
        `The parts taken from ${style.like} play ${missing.join(", ")}: define those voices, or write parts of your own.`,
      );
  }
  const beats = style.beats ?? base?.beats ?? 4;
  const grid = style.grid ?? base?.grid ?? 2;
  const steps = beats * grid;
  if (style.parts) {
    const tunes = new Set(style.parts.flatMap((p) => (p.part === "tune" ? [p.id] : [])));
    let notes = 0;
    style.parts.forEach((p, i) => {
      const where = `parts[${i}] (${p.part})`;
      const voice = p.part === "tune" ? p.tune.voice : p.voice;
      if (!voices.has(voice))
        // i18n-exempt: a fault served to the first mate in English
        faults.push(`${where} plays the voice ${voice}, which voices does not define.`);
      if (p.part === "tune") {
        if (p.tune.harmVoice && !voices.has(p.tune.harmVoice))
          // i18n-exempt: a fault served to the first mate in English
          faults.push(`${where} harmonizes on ${p.tune.harmVoice}, which voices does not define.`);
        if (p.tune.share && !tunes.has(p.tune.share))
          // i18n-exempt: a fault served to the first mate in English
          faults.push(`${where} shares motifs with ${p.tune.share}, which is no tune's id.`);
        if (p.tune.lo !== undefined && p.tune.hi !== undefined && p.tune.lo > p.tune.hi)
          // i18n-exempt: a fault served to the first mate in English
          faults.push(`${where} has lo above hi.`);
        if (p.tune.rhythms.some((r) => r.some(([s]) => s >= steps)))
          // i18n-exempt: a fault served to the first mate in English
          faults.push(`${where} has a rhythm step past the bar's last, ${steps - 1}.`);
      }
      // i18n-exempt: a fault served to the first mate in English
      if (p.part === "pings" && p.lo > p.hi) faults.push(`${where} has lo above hi.`);
      const used =
        p.part === "steps"
          ? p.hits.map((h) => h[0])
          : p.part === "strum"
            ? p.hits.map((h) => h[0])
            : p.part === "pattern"
              ? (p.steps ?? [])
              : [];
      if (used.some((s) => s >= steps))
        faults.push(
          // i18n-exempt: a fault served to the first mate in English
          `${where} plays a step past the bar's last, ${steps - 1} (${beats} beats of ${grid}).`,
        );
      notes += partNotes(p, steps);
    });
    if (notes > OWN_STYLE_NOTES_MAX)
      faults.push(
        // i18n-exempt: a fault served to the first mate in English
        `The parts ask for up to ${notes} notes a bar; keep it to ${OWN_STYLE_NOTES_MAX}, as calm music needs far fewer.`,
      );
  }
  if (JSON.stringify(style).length > OWN_STYLE_CHARS_MAX)
    faults.push(
      // i18n-exempt: a fault served to the first mate in English
      `The style is longer than ${OWN_STYLE_CHARS_MAX} characters; say it in fewer parts.`,
    );
  return faults;
}
