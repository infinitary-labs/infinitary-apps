// The ambient music's composer (docs/ambient-music.md). A style
// (./styles/) is data - its key, tempo, chord walk, layers at each crew
// level and voices - and one compose function that writes a bar's notes;
// the composer walks the style's chords and hands each bar to it.
//
// DOM-free, seeded and time-injected, like the notice pulse
// (../character/notice.ts): from a seed, the crew level and the bar's
// events it returns each bar's notes in beats, and the player
// (./player.ts) turns them into sound. One seed gives the same bars.

/**
 * How much of the crew is working: 0 nobody, 1 one or two crewmates, 2
 * three or more.
 */
export type CrewLevel = 0 | 1 | 2;

/** The crew level for a count of working crewmates. */
export function crewLevel(working: number): CrewLevel {
  return working >= 3 ? 2 : working >= 1 ? 1 : 0;
}

/** The layers whose loudness follows the crew level. */
export const LAYERS = [
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
export type Layer = (typeof LAYERS)[number];
/** A layer, or the cues' own bus. */
export type Bus = Layer | "cue";

/** One note: when it starts in beats from its bar or cue, how long it is in beats, and how loud and where. */
export type Note = {
  /** The style's voice that plays it, or `glow`, the waiting chime's held note. */
  voice: string;
  midi: number;
  beat: number;
  length: number;
  velocity: number;
  /** -1 left .. 1 right. */
  pan: number;
};

/**
 * A chord, counted in the style's scale: `d` the degree it stands on, `t`
 * its tones as steps up from it, `b` a bass degree other than `d`, `x` a
 * tone moved off the scale by semitones (by its place in `t`), `hold` how
 * many bars it lasts, and `p` which of its tones the pad plays.
 */
export type Chord = {
  d: number;
  t: number[];
  b?: number;
  x?: Record<number, number>;
  hold?: number;
  p?: number[];
};

/** One composed bar. */
export type Bar = {
  index: number;
  level: CrewLevel;
  chord: string;
  /** 0 calm .. 1 the crew working: the pad's warmth and opening. */
  heat: number;
  /** The pad's notes, low and wide. */
  pad: number[];
  /** How loud each layer plays this bar, 0..1; the player ramps to it over the bar. */
  layers: Record<Layer, number>;
  notes: Note[];
  /** Whether the bar starts a chord, and where it stands in the chord's bars. */
  newChord: boolean;
  barInChord: number;
  chordBars: number;
};

/** The part of a style the composer reads; the player reads the rest (./player.ts). */
export type Score = {
  /** Beats a minute, beats in a bar, and grid steps in a beat: 2 for eighths, 3 for a rocking triplet feel. */
  bpm: number;
  beats: number;
  grid: number;
  /** How far each off-beat eighth is pushed late, in beats. */
  swing?: number;
  /** How many bars a chord lasts unless it says otherwise. */
  hold: number;
  /** The key's pitch class, its scale as semitones, and its five-note scale as scale degrees. */
  tonic: number;
  scale: readonly number[];
  pent: readonly number[];
  chords: Record<string, Chord>;
  start: string;
  /** Where each chord may go next; a repeat makes that move likelier. */
  next: Record<string, string[]>;
  /** The chords a merge steers to, the last one home. */
  cadence: string[];
  /** The hands' range, where their center may sit, and the first voicing. */
  keys: { lo: number; hi: number; c: [number, number]; start: number[] };
  /** The pad's lowest notes, one for each of its voices, and which chord tones it plays. */
  pad: { anchors: number[]; tones?: number[] };
  levels: Record<CrewLevel, { heat: number; layers: Record<Layer, number> }>;
  /** The cues: a shift in semitones, the chime's ring in seconds and loudness, the sparks' run and ring, and each cue's level in dB. */
  cue: {
    shift?: number;
    ring?: number;
    vel?: number;
    run?: number;
    sparkRing?: number;
    sparkVel?: number;
    gain: [number, number];
  };
  compose: (k: BarContext) => void;
};

export const pitchClass = (midi: number) => ((midi % 12) + 12) % 12;
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** The nearest note at or above `from` with this pitch class. */
export function upTo(from: number, pc: number): number {
  let m = Math.round(from);
  while (pitchClass(m) !== pc) m += 1;
  return m;
}

/** A small seeded generator (mulberry32): the same seed gives the same music. */
function seeded(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bars that must pass between two waiting chimes. */
const CHIME_EVERY_BARS = 2;

/** A remembered one-bar motif: its rhythm as [grid step, length in steps], and its scale steps. */
type Motif = { rhythm: [number, number][]; degs: number[]; cycle: number };

/** How a tune is played (`BarContext.tune`). */
export type TuneOptions = {
  voice: string;
  /** The letters walked a bar at a time; "-" rests. */
  form: string;
  /** The note the tune centers on. */
  center: number;
  rhythms: [number, number][][];
  /** Another tune whose motifs this one answers with. */
  share?: string;
  /** How many cycles of the form before a motif is made anew. */
  renew?: number;
  starts?: number[];
  moves?: number[];
  lo?: number;
  hi?: number;
  /** Step along the five-note scale instead of the seven. */
  pent?: boolean;
  /** How often an inner note moves a step. */
  vary?: number;
  /** Land every note, not only the strong ones, on a chord tone. */
  chordOnly?: boolean;
  legato?: number;
  tail?: number;
  vel?: number;
  pan?: number;
  /** How often a long note gets a grace note from above. */
  grace?: number;
  /** A second voice this many scale steps away. */
  harm?: number;
  harmVoice?: string;
};

/** Notes a style's compose function may keep from bar to bar. */
export type Memo = { arp?: number; pat?: number[]; ost?: number[]; pate?: number[] };

/** One bar being composed: what a style's compose function reads and writes. */
export class BarContext {
  readonly notes: Note[] = [];
  readonly steps: number;
  readonly grid: number;
  /** The five-note scale's pitch classes. */
  readonly pentPcs: number[];
  readonly voicing: number[];
  readonly memo: Memo;

  constructor(
    private readonly c: Composer,
    readonly s: Score,
    readonly index: number,
    readonly level: CrewLevel,
    /** The crew level the bar before played. */
    readonly was: CrewLevel,
    readonly layers: Record<Layer, number>,
    readonly chord: Chord,
    /** The chord's pitch classes. */
    readonly tones: number[],
    readonly rootPc: number,
    /** Scale degrees this chord moves off the scale, by semitones. */
    private readonly alter: Record<number, number>,
    readonly newChord: boolean,
    /** Whether a merge's cadence lands home this bar. */
    readonly resolved: boolean,
    readonly barInChord: number,
    readonly chordBars: number,
  ) {
    this.grid = s.grid;
    this.steps = s.beats * s.grid;
    this.voicing = c.voicing;
    this.memo = c.memo;
    this.pentPcs = s.pent.map((d) => pitchClass(s.tonic + (s.scale[d] as number)));
  }

  rand(): number {
    return this.c.random();
  }
  chance(p: number): boolean {
    return this.c.random() < p;
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.c.random() * a.length)] as T;
  }
  /** A few milliseconds early or late, in beats. */
  hum(): number {
    return (this.c.random() - 0.5) * 0.012;
  }
  /** A grid step's place in beats, its off-beats swung late in simple time. */
  step(n: number): number {
    const s = this.s;
    return n / s.grid + (s.grid === 2 && n % 2 ? s.swing || 0 : 0);
  }
  /** Whether a layer sounds this bar: on now, or leaving and playing its last bar. */
  on(layer: Layer): boolean {
    return this.layers[layer] > 0 || this.s.levels[this.was].layers[layer] > 0;
  }
  add(voice: string, midi: number, beat: number, length: number, velocity: number, pan = 0): void {
    this.notes.push({ voice, midi, beat: Math.max(0, beat), length, velocity, pan });
  }
  /** The chord's root at or above `lo`. */
  bass(lo = 38): number {
    return upTo(lo, this.rootPc);
  }
  /** The note nearest `target` among these pitch classes. */
  near(target: number, pcs: number[], lo = 24, hi = 108): number {
    let best: number | null = null;
    let distance = 1e9;
    for (let m = lo; m <= hi; m += 1) {
      if (!pcs.includes(pitchClass(m))) continue;
      const d = Math.abs(m - target);
      if (d < distance) {
        distance = d;
        best = m;
      }
    }
    return best === null ? Math.round(target) : best;
  }
  /** Chord tones climbing from `from`, `n` of them. */
  climb(from: number, n: number): number[] {
    const out: number[] = [];
    for (let m = from; m < 110 && out.length < n; m += 1)
      if (this.tones.slice(0, 3).includes(pitchClass(m))) out.push(m);
    return out;
  }
  /** A scale degree counted from the tonic nearest `center`, with this chord's altered tones. */
  degMidi(center: number, abs: number): number {
    const base = upTo(center - 6, this.s.tonic);
    const d = ((abs % 7) + 7) % 7;
    return base + this.c.deg(abs) + (this.alter[d] || 0);
  }

  /**
   * A tune: one-bar motifs remembered by letter and replayed over the chord
   * of the bar, so the melody repeats like a song and still never loops.
   */
  tune(key: string, o: TuneOptions): void {
    const tunes = this.c.tunes;
    const blank = () => ({ pos: 0, motifs: {} as Record<string, Motif> });
    const memoOf = (name: string) => {
      tunes[name] ??= blank();
      return tunes[name];
    };
    const st = memoOf(key);
    const mem = o.share ? memoOf(o.share) : st;
    const letter = o.form[st.pos % o.form.length] as string;
    const cycle = Math.floor(st.pos / o.form.length);
    st.pos += 1;
    if (letter === "-") return;
    let m = mem.motifs[letter];
    const age = o.renew || 3;
    if (!m || (!o.share && m.cycle + (letter === "A" ? age * 2 : age) <= cycle)) {
      const rhythm = this.pick(o.rhythms);
      let d = this.pick(o.starts || [0, 2, 4]);
      const degs = rhythm.map((_, i) => {
        if (i > 0) d += this.pick(o.moves || [-2, -1, -1, 1, 1, 2, 0]);
        d = clamp(d, o.lo === undefined ? -3 : o.lo, o.hi === undefined ? 8 : o.hi);
        return d;
      });
      m = { rhythm, degs, cycle };
      mem.motifs[letter] = m;
    }
    const motif = m;
    const chordBase = this.chord.d > 3 ? this.chord.d - 7 : this.chord.d;
    const chordSet = this.chord.t.slice(0, 3).map((x) => ((x % 7) + 7) % 7);
    const isTone = (r: number) => chordSet.includes(((r % 7) + 7) % 7);
    const pent = o.pent ? this.s.pent : null;
    const n = motif.rhythm.length;
    const vary = o.vary === undefined ? 0.15 : o.vary;
    // A five-note tune steps along the five notes, not the seven: its motif
    // counts places in that scale from the one nearest the chord's root.
    const P = pent ? pent.length : 0;
    const pentDeg = (i: number) => (pent?.[((i % P) + P) % P] as number) + 7 * Math.floor(i / P);
    let baseIdx = 0;
    if (pent) {
      let bd = 99;
      for (let i = -P; i <= P; i += 1) {
        const d = Math.abs(pentDeg(i) - chordBase);
        if (d < bd) {
          bd = d;
          baseIdx = i;
        }
      }
    }
    const up = (a: number, by: number) => {
      if (!pent) return a + by;
      let i = -2 * P;
      while (pentDeg(i) < a) i += 1;
      return pentDeg(i + by);
    };
    const abs = motif.rhythm.map(([step], i) => {
      let rel = motif.degs[i] as number;
      if (i > 0 && i < n - 1 && this.chance(vary)) rel += this.chance(0.5) ? 1 : -1;
      const snap = step % this.grid === 0 || i === n - 1 || o.chordOnly;
      if (!pent) {
        if (snap && !isTone(rel)) rel += isTone(rel - 1) ? -1 : 1;
        return chordBase + rel;
      }
      let idx = baseIdx + rel;
      if (snap)
        for (const by of [0, -1, 1, -2, 2])
          if (isTone(pentDeg(idx + by) - chordBase)) {
            idx += by;
            break;
          }
      return pentDeg(idx);
    });
    // A tune that ends by repeating its last note mostly falls to the chord tone below instead.
    if (n > 1 && abs[n - 1] === abs[n - 2] && this.chance(0.7))
      for (let g = 0; g < 4; g += 1) {
        abs[n - 1] = up(abs[n - 1] as number, -1);
        if (isTone((abs[n - 1] as number) - chordBase)) break;
      }
    // Three of the same note in a row is a stutter, not a tune: lift the middle one.
    for (let i = 1; i < n - 1; i += 1)
      if (abs[i] === abs[i - 1] && abs[i] === abs[i + 1]) abs[i] = up(abs[i] as number, 1);
    let midis = abs.map((a) => this.degMidi(o.center, a));
    const mean = midis.reduce((x, y) => x + y, 0) / n;
    const shift = Math.round((o.center - mean) / 12) * 12;
    midis = midis.map((x) => x + shift);
    motif.rhythm.forEach(([step, len], i) => {
      const last = i === n - 1;
      const strong = step % this.grid === 0;
      const beat = this.step(step) + this.hum();
      const length = (len / this.grid) * (o.legato || 0.92) + (last ? o.tail || 0 : 0);
      const vel = (o.vel || 0.85) * (strong ? 1 : 0.86) * (0.93 + this.rand() * 0.14);
      const pan = o.pan === undefined ? 0.12 : o.pan;
      if (o.grace && len >= 2 && i > 0 && this.chance(o.grace))
        this.add(
          o.voice,
          this.degMidi(o.center, up(abs[i] as number, 1)) + shift,
          beat - 0.07,
          0.08,
          vel * 0.5,
          pan,
        );
      this.add(o.voice, midis[i] as number, beat, length, vel, pan);
      if (o.harm) {
        const a = up(abs[i] as number, o.harm);
        this.add(
          o.harmVoice || o.voice,
          this.degMidi(o.center, a) + shift,
          beat + 0.01,
          length,
          vel * 0.62,
          -pan,
        );
      }
    });
  }
}

export class Composer {
  readonly random: () => number;
  /** The tunes' remembered motifs, and the notes a style keeps between bars. */
  readonly tunes: Record<string, { pos: number; motifs: Record<string, Motif> }> = {};
  readonly memo: Memo = {};
  voicing: number[];
  private readonly beatSeconds: number;
  private index = 0;
  private chordName: string;
  private chordBars = 1;
  private barInChord = 0;
  private previous: CrewLevel | null = null;
  /** The chords a merge steers to, played before the walk goes on. */
  private resolving: string[] = [];
  private lastChimeBar = -Infinity;

  constructor(
    readonly s: Score,
    seed: number,
  ) {
    this.random = seeded(seed);
    this.chordName = s.start;
    this.voicing = s.keys.start.slice();
    this.beatSeconds = 60 / s.bpm;
  }

  /** The bar the next call of `bar` composes. */
  get nextIndex(): number {
    return this.index;
  }

  /** A scale degree's semitones above the tonic, counting octaves. */
  deg(n: number): number {
    const i = ((n % 7) + 7) % 7;
    return (this.s.scale[i] as number) + 12 * Math.floor(n / 7);
  }

  /** A chord's pitch classes. */
  chordPcs(chord: Chord): number[] {
    return chord.t.map((off, i) =>
      pitchClass(this.s.tonic + this.deg(chord.d + off) + (chord.x?.[i] ?? 0)),
    );
  }

  /**
   * A card landed unseen: the waiting chime, three notes up the home chord
   * and a held note that swells on the notice pulse's curve and spreads to
   * both sides, in beats from where the player starts it. Null when a chime
   * played less than two bars before `atBar`.
   */
  waiting(atBar: number): Note[] | null {
    if (atBar - this.lastChimeBar < CHIME_EVERY_BARS) return null;
    this.lastChimeBar = atBar;
    const s = this.s;
    const cue = s.cue;
    const base = upTo(69, s.tonic) + (cue.shift || 0);
    const stepSeconds = this.beatSeconds / s.grid;
    const gap = Math.max(1, Math.round(0.43 / stepSeconds)) / s.grid;
    const midis = [2, 4, 7].map((d) => base + this.deg(d));
    const notes: Note[] = midis.map((midi, k) => ({
      voice: "chime",
      midi,
      beat: k * gap,
      length: (cue.ring || 2.4) / this.beatSeconds,
      velocity: (cue.vel || 0.075) * 10 ** (cue.gain[0] / 20),
      pan: (k - 1) * 0.25,
    }));
    notes.push({
      voice: "glow",
      midi: midis[2] as number,
      beat: gap * 3,
      length: 2.6,
      velocity: 0.03,
      pan: 0,
    });
    return notes;
  }

  /** A task merged: the next chords resolve home, and a rising run plays now. */
  merged(): Note[] {
    const s = this.s;
    const cue = s.cue;
    this.resolving = s.cadence.slice();
    const base = upTo(69, s.tonic) + (cue.shift || 0);
    return [0, 2, 4, 6, 8, 9, 11].map((d, k) => ({
      voice: "spark",
      midi: base + this.deg(d),
      beat: (k * (cue.run || 0.111) + this.random() * 0.017) / this.beatSeconds,
      length: (cue.sparkRing || 1.63) / this.beatSeconds,
      velocity: (cue.sparkVel || 0.05) * 10 ** (cue.gain[1] / 20),
      pan: -0.7 + k * 0.23,
    }));
  }

  /** Composes the next bar for the crew level now. */
  bar(level: CrewLevel): Bar {
    const s = this.s;
    const index = this.index;
    this.index += 1;
    const { heat, layers } = s.levels[level];
    const was = this.previous === null ? level : this.previous;
    this.previous = level;
    let newChord = false;
    let resolved = false;
    const steered = this.resolving.shift();
    const holdOf = (name: string) => s.chords[name]?.hold || s.hold || 1;
    if (steered) {
      this.chordName = steered;
      resolved = this.resolving.length === 0;
      this.chordBars = resolved ? holdOf(steered) : 1;
      this.barInChord = 0;
      newChord = true;
    } else if (index === 0) {
      this.chordBars = holdOf(this.chordName);
      newChord = true;
    } else if (this.barInChord + 1 >= this.chordBars) {
      const options = s.next[this.chordName] as string[];
      this.chordName = options[Math.floor(this.random() * options.length)] as string;
      this.chordBars = holdOf(this.chordName);
      this.barInChord = 0;
      newChord = true;
    } else this.barInChord += 1;
    const chord = s.chords[this.chordName] as Chord;
    const tones = this.chordPcs(chord);
    const rootPc = pitchClass(s.tonic + this.deg(chord.b === undefined ? chord.d : chord.b));
    if (newChord) this.voicing = this.voice(tones);
    const alter: Record<number, number> = {};
    if (chord.x)
      for (const [i, by] of Object.entries(chord.x))
        alter[(((chord.d + (chord.t[Number(i)] as number)) % 7) + 7) % 7] = by;
    const padPcs = (chord.p || s.pad.tones || [0, 2, 1]).map(
      (i) => tones[i % tones.length] as number,
    );
    const pad = padPcs.map((p, k) => upTo(s.pad.anchors[k] as number, k === 0 ? rootPc : p));
    const k = new BarContext(
      this,
      s,
      index,
      level,
      was,
      layers,
      chord,
      tones,
      rootPc,
      alter,
      newChord,
      resolved,
      this.barInChord,
      this.chordBars,
    );
    s.compose(k);
    return {
      index,
      level,
      chord: this.chordName,
      heat,
      pad,
      layers,
      notes: k.notes,
      newChord,
      barInChord: this.barInChord,
      chordBars: this.chordBars,
    };
  }

  /** The chord's tones voiced near the last voicing's center, so the hands barely move. */
  private voice(tones: number[]): number[] {
    const r = this.s.keys;
    const center = this.voicing.reduce((a, b) => a + b, 0) / this.voicing.length;
    const target = clamp(center + (this.random() - 0.5) * 2, r.c[0], r.c[1]);
    return tones
      .map((pc) => {
        let best = r.lo;
        for (let m = r.lo; m <= r.hi; m += 1)
          if (
            pitchClass(m) === pc &&
            (pitchClass(best) !== pc || Math.abs(m - target) < Math.abs(best - target))
          )
            best = m;
        return best;
      })
      .sort((a, b) => a - b);
  }
}
