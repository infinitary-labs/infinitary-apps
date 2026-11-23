// The ambient music's instruments (docs/ambient-music.md): every sound is
// made of oscillators, with no recorded samples. Each instrument plays one
// note from its preset, and every node it makes is disconnected when the
// note's last source ends, so an hour of play holds no more than a minute
// does.

import type { Note } from "./composer";

export const mtof = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** The highest partial an instrument asks for: under half the window's 24 kHz rate. */
const TOP_HZ = 10500;

export type FmPreset = {
  ratio: number;
  idx: number;
  idxEnd: number;
  idxT: number;
  amp: number;
  sus: number;
  susTau: number;
  rel: number;
  tail: number;
};
/** A plucked string: its oscillators as [type, gain, cents], how bright it starts and how fast it darkens and rings down. */
export type PluckPreset = {
  mix: [OscillatorType, number, number?][];
  bright: number;
  dark: number;
  sweep: number;
  decay: number;
  amp: number;
  q?: number;
};
/** A struck bar, bell or tine: partials as [ratio, gain, how much of the ring it lasts]. */
export type MalletPreset = {
  partials: [number, number, number][];
  att?: number;
  amp?: number;
  ring?: number;
  tune?: number;
};
/** A held voice: oscillators as [type, gain, multiple, cents], a filter, a vibrato as [Hz, cents, delay, rise]. */
export type SusPreset = {
  osc: [OscillatorType, number, number, number?][];
  lp?: { f?: number; k?: number; max?: number; q?: number };
  vib?: [number, number, number, number];
  att: number;
  rel: number;
  amp: number;
  sus?: number;
  glide?: number;
  scoop?: number;
};
export type BassPreset = { amp?: number };
/** A drum made of a falling sine, and a triangle skin as [Hz, gain, decay]. */
export type DrumPreset = {
  f: [number, number];
  drop: number;
  decay: number;
  amp: number;
  att?: number;
  tuned?: boolean;
  skin?: [number, number, number];
};
/** Wood made of tones alone: each tone as [Hz, gain, decay], or sets of them a note's number picks. */
export type WoodPreset = {
  set?: [number, number, number][];
  sets?: [number, number, number][][];
  fall?: number;
};
export type TickPreset = { amp?: number; decay?: number; hp?: number; f?: number[] };

/** A note as an instrument plays it: `touch` is how hard it was struck, before its voice's own level. */
export type Played = Note & { touch?: number };

/** What every instrument needs from the player. */
export type Stage = {
  ctx: BaseAudioContext;
  panned(node: AudioNode, pan: number, to: AudioNode): StereoPannerNode;
  /** Starts the sources, stops them at `end`, and frees every node once the last one ends. */
  run(sources: AudioScheduledSourceNode[], nodes: AudioNode[], at: number, end: number): void;
  /** The last frequency each held voice played, for a glide. */
  lastF: Record<string, number>;
};

export function fm(s: Stage, note: Played, t: number, length: number, to: AudioNode, p: FmPreset) {
  const ctx = s.ctx;
  const f = mtof(note.midi);
  const carrier = ctx.createOscillator();
  carrier.frequency.value = f;
  const modulator = ctx.createOscillator();
  modulator.frequency.value = f * p.ratio;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(f * p.idx * (note.touch || note.velocity), t);
  depth.gain.exponentialRampToValueAtTime(f * p.idxEnd, t + p.idxT);
  modulator.connect(depth).connect(carrier.frequency);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(note.velocity * p.amp, t + 0.008);
  amp.gain.setTargetAtTime(note.velocity * p.amp * p.sus, t + 0.008, p.susTau);
  amp.gain.setTargetAtTime(0, t + length, p.rel);
  carrier.connect(amp);
  const panner = s.panned(amp, note.pan, to);
  s.run([modulator, carrier], [depth, amp, panner], t, t + length + p.tail);
}

export function pluck(
  s: Stage,
  note: Played,
  t: number,
  length: number,
  to: AudioNode,
  p: PluckPreset,
) {
  const ctx = s.ctx;
  const f = mtof(note.midi);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = p.q || 0.7;
  const touch = Math.min(1, note.touch || note.velocity);
  filter.frequency.setValueAtTime(Math.min(9000, f * p.bright * (0.6 + 0.5 * touch)), t);
  filter.frequency.exponentialRampToValueAtTime(Math.max(180, f * p.dark), t + p.sweep);
  const decay = p.decay * (262 / f) ** 0.3;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(note.velocity * p.amp, t + 0.004);
  amp.gain.setTargetAtTime(0, t + 0.004, decay);
  const ring = Math.min(length, decay * 5);
  amp.gain.setTargetAtTime(0, t + ring, 0.05);
  const sources: OscillatorNode[] = [];
  const gains: GainNode[] = [];
  for (const [type, gain, cents] of p.mix) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (cents) o.detune.value = cents;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(filter);
    sources.push(o);
    gains.push(g);
  }
  filter.connect(amp);
  const panner = s.panned(amp, note.pan, to);
  s.run(sources, [...gains, filter, amp, panner], t, t + ring + 0.3);
}

/** A struck bar, bell or tine. */
export function mallet(
  s: Stage,
  note: Played,
  t: number,
  length: number,
  to: AudioNode,
  p: MalletPreset,
) {
  const ctx = s.ctx;
  const f = mtof(note.midi) * (p.tune || 1);
  const amp = ctx.createGain();
  amp.gain.value = note.velocity * (p.amp || 1);
  const sources: OscillatorNode[] = [];
  const nodes: AudioNode[] = [amp];
  const ring = Math.max(0.12, p.ring || length);
  for (const [ratio, level, part] of p.partials) {
    if (f * ratio > TOP_HZ) continue;
    const o = ctx.createOscillator();
    o.frequency.value = f * ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + (p.att || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0003, t + Math.max(0.05, ring * part));
    o.connect(g).connect(amp);
    sources.push(o);
    nodes.push(g);
  }
  nodes.push(s.panned(amp, note.pan, to));
  // The longest partial comes first, so it is the one whose end frees the note.
  s.run(sources.reverse(), nodes, t, t + ring + 0.05);
}

/** A glass tone: a sine with two soft inharmonic partials. */
export function glass(s: Stage, note: Played, t: number, length: number, to: AudioNode) {
  const ctx = s.ctx;
  const f = mtof(note.midi);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(note.velocity, t + 0.004);
  amp.gain.exponentialRampToValueAtTime(note.velocity * 0.25, t + 0.25);
  amp.gain.exponentialRampToValueAtTime(0.0003, t + length);
  const sources: OscillatorNode[] = [];
  const nodes: AudioNode[] = [amp];
  for (const [ratio, level] of [
    [1, 1],
    [2.76, 0.18],
    [5.4, 0.05],
  ] as const) {
    if (f * ratio > TOP_HZ) continue;
    const o = ctx.createOscillator();
    o.frequency.value = f * ratio;
    const g = ctx.createGain();
    g.gain.value = level;
    o.connect(g).connect(amp);
    sources.push(o);
    nodes.push(g);
  }
  nodes.push(s.panned(amp, note.pan, to));
  s.run(sources, nodes, t, t + length + 0.05);
}

/** A held voice: a whistle, flute, fiddle, horn, cello or a synth lead. */
export function sus(
  s: Stage,
  note: Played,
  t: number,
  length: number,
  to: AudioNode,
  p: SusPreset,
  name: string,
) {
  const ctx = s.ctx;
  const f = mtof(note.midi);
  const sources: OscillatorNode[] = [];
  const nodes: AudioNode[] = [];
  const amp = ctx.createGain();
  const peak = note.velocity * p.amp;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(peak, t + p.att);
  amp.gain.setTargetAtTime(peak * (p.sus === undefined ? 0.75 : p.sus), t + p.att, 0.3);
  amp.gain.setTargetAtTime(0, t + length, p.rel);
  let into: AudioNode = amp;
  if (p.lp) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = p.lp.q || 0.7;
    const cut = p.lp.f || Math.min(p.lp.max || 4000, f * (p.lp.k ?? 1));
    filter.frequency.setValueAtTime(cut * 0.6, t);
    filter.frequency.setTargetAtTime(cut, t, p.att * 1.5);
    filter.connect(amp);
    nodes.push(filter);
    into = filter;
  }
  let vibratoDepth: GainNode | null = null;
  if (p.vib) {
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = p.vib[0];
    vibratoDepth = ctx.createGain();
    vibratoDepth.gain.value = 0;
    vibratoDepth.gain.setValueAtTime(0, t + p.vib[2]);
    vibratoDepth.gain.linearRampToValueAtTime(p.vib[1], t + p.vib[2] + p.vib[3]);
    vibrato.connect(vibratoDepth);
    sources.push(vibrato);
    nodes.push(vibratoDepth);
  }
  const from = p.glide ? s.lastF[name] : 0;
  for (const [type, gain, multiple, cents] of p.osc) {
    const o = ctx.createOscillator();
    o.type = type;
    if (from && p.glide) {
      o.frequency.setValueAtTime(from * multiple, t);
      o.frequency.setTargetAtTime(f * multiple, t, p.glide);
    } else o.frequency.value = f * multiple;
    if (p.scoop) {
      o.detune.setValueAtTime(p.scoop + (cents || 0), t);
      o.detune.setTargetAtTime(cents || 0, t, 0.035);
    } else if (cents) o.detune.value = cents;
    if (vibratoDepth) vibratoDepth.connect(o.detune);
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(into);
    sources.push(o);
    nodes.push(g);
  }
  s.lastF[name] = f;
  nodes.push(amp, s.panned(amp, note.pan, to));
  s.run(sources, nodes, t, t + length + p.rel * 6);
}

export function bass(
  s: Stage,
  note: Played,
  t: number,
  length: number,
  to: AudioNode,
  p: BassPreset | null,
) {
  const ctx = s.ctx;
  const sine = ctx.createOscillator();
  sine.frequency.value = mtof(note.midi);
  const triangle = ctx.createOscillator();
  triangle.type = "triangle";
  triangle.frequency.value = mtof(note.midi);
  const amp = ctx.createGain();
  const a = p?.amp || 0.24;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(note.velocity * a, t + 0.015);
  amp.gain.setTargetAtTime(note.velocity * a * 0.54, t + 0.015, 0.3);
  amp.gain.setTargetAtTime(0, t + length, 0.08);
  sine.connect(amp);
  triangle.connect(amp);
  amp.connect(to);
  s.run([sine, triangle], [amp], t, t + length + 0.6);
}

export function drum(s: Stage, note: Played, t: number, to: AudioNode, p: DrumPreset) {
  const ctx = s.ctx;
  const base = p.tuned ? mtof(note.midi) : 1;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(p.f[0] * base, t);
  o.frequency.exponentialRampToValueAtTime(p.f[1] * base, t + p.drop);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(note.velocity * p.amp, t + (p.att || 0.004));
  amp.gain.exponentialRampToValueAtTime(0.001, t + p.decay);
  o.connect(amp).connect(to);
  const sources: OscillatorNode[] = [o];
  const nodes: AudioNode[] = [amp];
  if (p.skin) {
    const skin = ctx.createOscillator();
    skin.type = "triangle";
    skin.frequency.setValueAtTime(p.skin[0] * base, t);
    skin.frequency.exponentialRampToValueAtTime(p.skin[0] * base * 0.8, t + p.skin[2]);
    const g = ctx.createGain();
    g.gain.setValueAtTime(note.velocity * p.skin[1], t);
    g.gain.exponentialRampToValueAtTime(0.001, t + p.skin[2] + 0.03);
    skin.connect(g).connect(to);
    sources.unshift(skin);
    nodes.push(g);
  }
  s.run(sources, nodes, t, t + p.decay + 0.02);
}

/** Wood: a rim, a stick, a small log drum, made of tones alone. */
export function wood(s: Stage, note: Played, t: number, to: AudioNode, p: WoodPreset) {
  const ctx = s.ctx;
  const set = (p.sets ? p.sets[note.midi % p.sets.length] : p.set) ?? [];
  const sources: OscillatorNode[] = [];
  const nodes: AudioNode[] = [];
  let longest = 0;
  for (const [f, a, d] of set) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (p.fall || 0.82), t + d);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(note.velocity * a, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + d + 0.04);
    o.connect(amp);
    sources.push(o);
    nodes.push(amp);
    longest = Math.max(longest, d + 0.07);
  }
  const panner = ctx.createStereoPanner();
  panner.pan.value = note.pan;
  for (const node of nodes) node.connect(panner);
  panner.connect(to);
  nodes.push(panner);
  s.run(sources.reverse(), nodes, t, t + longest);
}

export function tick(s: Stage, note: Played, t: number, to: AudioNode, p: TickPreset | null) {
  const ctx = s.ctx;
  const decay = p?.decay || 0.03;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(note.velocity * (p?.amp || 0.03), t);
  amp.gain.exponentialRampToValueAtTime(0.0005, t + decay);
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = p?.hp || 6000;
  const sources = (p?.f || [5200, 7400]).map((f) => {
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = f;
    o.connect(highpass);
    return o;
  });
  highpass.connect(amp).connect(to);
  s.run(sources, [highpass, amp], t, t + decay + 0.005);
}

/**
 * A piano made of oscillators. Two copies of the same low partials, a few
 * cents apart, are the struck string pair: the one in tune fades fast and
 * the other rings on, so the note falls quickly and then sings, beating
 * slowly while both sound. A bright strike of the upper partials fades
 * first, and a filter closes as the note rings, as a piano darkens.
 */
export type PianoPreset = {
  amp: number;
  /** The strike's filter at full touch, and where it settles, as multiples of the note. */
  bright: number;
  dark: number;
  /** How fast the filter closes, in seconds. */
  close: number;
  /** The fast first fall and the long ring, in seconds at middle C; lower notes ring longer. */
  prompt: number;
  ring: number;
  /** How much of the note is the long ring, 0..1. */
  sing: number;
  /** The string pair's spread in cents. */
  beat: number;
  /** How loud the bright strike is. */
  strike: number;
  /** The hammer's attack in seconds: a felt hammer is slower. */
  att?: number;
  /** How fast the damper stops a released note, in seconds. */
  damp?: number;
};

/** A piano's partials, as sine amplitudes from the first: the body, and the strike. */
const PIANO_BODY = [0, 1, 0.38, 0.2, 0.11, 0.05, 0.025];
const PIANO_STRIKE = [0, 0, 0.5, 0.42, 0.34, 0.27, 0.22, 0.18, 0.14, 0.11, 0.09, 0.07, 0.05];
/** One pair of piano waves per audio context, made once. */
const pianoWaves = new WeakMap<BaseAudioContext, [PeriodicWave, PeriodicWave]>();

function wavesOf(ctx: BaseAudioContext): [PeriodicWave, PeriodicWave] {
  let waves = pianoWaves.get(ctx);
  if (!waves) {
    const make = (partials: number[]) =>
      ctx.createPeriodicWave(new Float32Array(partials.length), Float32Array.from(partials));
    waves = [make(PIANO_BODY), make(PIANO_STRIKE)];
    pianoWaves.set(ctx, waves);
  }
  return waves;
}

export function piano(
  s: Stage,
  note: Played,
  t: number,
  length: number,
  to: AudioNode,
  p: PianoPreset,
) {
  const ctx = s.ctx;
  const f = mtof(note.midi);
  const [body, bright] = wavesOf(ctx);
  const touch = Math.min(1, note.touch || note.velocity);
  const low = (262 / f) ** 0.5;
  const ring = Math.min(14, Math.max(0.8, p.ring * low));
  const prompt = Math.max(0.12, p.prompt * low ** 0.6);
  const att = p.att || 0.004;
  // Past four rings the note is all but silent, so a held note is let go there.
  const held = Math.min(length, ring * 4);
  const damp = p.damp || 0.12;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.5;
  filter.frequency.setValueAtTime(Math.min(TOP_HZ, f * p.bright * (0.45 + 0.75 * touch)), t);
  const settled = Math.min(TOP_HZ, Math.max(220, f * p.dark));
  filter.frequency.setTargetAtTime(settled, t + att, p.close);
  // Once the tone has closed, hold it still, so the filter stops working out its curve every sample.
  filter.frequency.setValueAtTime(settled, t + att + p.close * 6);
  const amp = ctx.createGain();
  amp.gain.value = note.velocity * p.amp;
  amp.gain.setTargetAtTime(0, t + held, damp);
  const sources: OscillatorNode[] = [];
  const nodes: AudioNode[] = [filter, amp];
  const end = t + held + damp * 5;
  const early: [OscillatorNode, number][] = [];
  const voice = (wave: PeriodicWave, cents: number, level: number, fall: number) => {
    const o = ctx.createOscillator();
    o.setPeriodicWave(wave);
    o.frequency.value = f;
    o.detune.value = cents;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + att);
    g.gain.setTargetAtTime(0, t + att, fall);
    o.connect(g).connect(filter);
    sources.push(o);
    nodes.push(g);
    // Seven falls down it is 60 dB under where it started: stop it there.
    const gone = t + att + fall * 7;
    if (gone < end) early.push([o, gone]);
  };
  // The quick parts first and the long ring last: the last to end frees the note.
  voice(bright, 0, p.strike * touch, prompt * 0.35);
  voice(body, -p.beat / 2, 1 - p.sing, prompt);
  voice(body, p.beat / 2, p.sing, ring);
  filter.connect(amp);
  nodes.push(s.panned(amp, note.pan, to));
  s.run(sources, nodes, t, end);
  for (const [o, gone] of early) if (o !== sources[sources.length - 1]) o.stop(gone);
}
