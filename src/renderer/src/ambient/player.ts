// The ambient music's player (docs/ambient-music.md): turns a style's bars
// into sound with Web Audio. No recorded samples: every note is an
// oscillator, and the only noise is the reverb's tail and, under a sea
// style, the soft wash of waves.
//
// It takes any audio context, so the same code plays live in the window
// (./ambient.ts) and renders offline for a check.

import { NOTICE_DURATION_MS, noticeFrame } from "../character/notice";
import {
  type Bar,
  type Bus,
  Composer,
  type CrewLevel,
  LAYERS,
  type Note,
  type Score,
} from "./composer";
import {
  type BassPreset,
  bass,
  type DrumPreset,
  drum,
  type FmPreset,
  fm,
  glass,
  type MalletPreset,
  mallet,
  mtof,
  type PianoPreset,
  type Played,
  type PluckPreset,
  piano,
  pluck,
  type Stage,
  type SusPreset,
  sus,
  type TickPreset,
  tick,
  type WoodPreset,
  wood,
} from "./instruments";

/**
 * How long the hush's fade to silence takes, in seconds: short enough that,
 * with the audio's own delay through the window, it is silent within 150 ms,
 * and long enough not to click.
 */
const HUSH_SECONDS = 0.02;
/** How loud the whole mix plays at full volume. */
const FULL = 0.9;
/** The waiting chime's held note runs the notice pulse's curve stretched this much, so it is heard. */
const GLOW_STRETCH = 1.6;
/** How loud a sea style's wash of waves plays: the captain's soft waves, 40% of the wash's own level. */
const WAVES = 0.4 * 0.3;

/**
 * A voice: the instrument that plays it, the bus it goes to, its preset,
 * and its own level in dB, which leaves how hard a note was struck alone.
 */
export type Voice =
  | readonly ["fm", Bus, FmPreset, number?]
  | readonly ["pluck", Bus, PluckPreset, number?]
  | readonly ["mallet", Bus, MalletPreset, number?]
  | readonly ["glass", Bus, null, number?]
  | readonly ["sus", Bus, SusPreset, number?]
  | readonly ["bass", Bus, BassPreset | null, number?]
  | readonly ["drum", Bus, DrumPreset, number?]
  | readonly ["piano", Bus, PianoPreset, number?]
  | readonly ["wood", Bus, WoodPreset, number?]
  | readonly ["tick", Bus, TickPreset | null, number?];

/** The pad's timbres (./styles/kit.ts). */
export type PadTimbre = {
  /** Each note's oscillators as [type, cents, gain, pan, multiple]. */
  osc: [OscillatorType, number, number, number, number][];
  /** The warm one heat brings in: [type, cents, multiple, level]. */
  warm: [OscillatorType, number, number, number] | null;
  /** Bands that shape the pad into voices: [Hz calm, Hz working, Q, gain]. */
  formants?: [number, number, number, number][];
  /** The filter's base and how far heat opens it. */
  f: [number, number];
  q: number;
  /** How much a pad whose filter closes as it warms is lifted to keep its level. */
  lift?: number;
};

/** The part of a style the player reads. */
export type Sound = {
  pad: {
    timbre: PadTimbre;
    amp: number;
    /** How fast it moves to the next chord, in seconds. */
    glide?: number;
    /** A dip as each chord changes, the bellows drawing breath. */
    dip?: number;
    /** A breath in and out each bar, or a tide every two bars. */
    swell?: number;
    tide?: number;
    /** Slow pitch drifts as [Hz, cents], and a slow sweep of its filter as [Hz, Hz deep]. */
    drift?: [number, number][];
    wobble?: [number, number];
  };
  /** The reverb's length in seconds and how much of it is heard. */
  reverb: number;
  wet: number;
  /** Two delays feeding each other, one each side, in beats. */
  echo?: { beats: number; fb: number; lp: number; mix: number };
  /** Each bus's lowpass, its send to the reverb and its send to the echo. */
  buses: Partial<Record<Bus, [number, number, number]>>;
  /** Each bus's level and the whole mix's, in dB, measured so every style plays as loud. */
  gains: Partial<Record<Bus, number>>;
  trim: number;
  /** A shelf above 1.4 kHz in dB that tilts the whole mix darker (under 0) or brighter. */
  tilt?: number;
  /** A sea style plays a soft wash of waves under the music. */
  sea?: boolean;
  voices: Record<string, Voice>;
};

export type Style = Score & Sound;

const BUS_DEFAULTS: Record<Bus, [number, number, number]> = {
  pad: [1000, 0.45, 0],
  keys: [3600, 0.3, 0],
  bass: [380, 0, 0],
  kick: [1500, 0, 0],
  rim: [3800, 0.06, 0],
  tick: [11000, 0.04, 0],
  lead: [5200, 0.5, 0],
  star: [11000, 1.1, 0],
  arp: [4200, 0.35, 0],
  cue: [11000, 0.8, 0],
};

/** A seeded reverb tail: a dark, decaying impulse. */
function impulse(ctx: BaseAudioContext, seed: number, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const pre = Math.floor(ctx.sampleRate * 0.025);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let a = seed | 0;
  const random = () => {
    a = (Math.imul(a, 1664525) + 1013904223) | 0;
    return (a >>> 0) / 4294967296;
  };
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    let lower = 0;
    for (let i = pre; i < length; i += 1) {
      const x = (random() * 2 - 1) * (1 - (i - pre) / (length - pre)) ** 2.6;
      const k = 0.35 - 0.3 * (i / length);
      low += (x - low) * k;
      lower += (low - lower) * k;
      data[i] = lower;
    }
  }
  return buffer;
}

/** Three seconds of soft, dark noise that loops: the sea's wash. */
function wash(ctx: BaseAudioContext, seed: number): { buffer: AudioBuffer; loopEnd: number } {
  const length = Math.floor(ctx.sampleRate * 3);
  const seam = 600;
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let a = (seed ^ 0x5bd1e995) | 0;
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i += 1) {
      a = (Math.imul(a, 1664525) + 1013904223) | 0;
      low += ((a >>> 0) / 2147483648 - 1 - low) * 0.25;
      data[i] = low;
    }
    // Ease the loop's seam.
    for (let i = 0; i < seam; i += 1) {
      const w = i / seam;
      data[i] = (data[i] as number) * w + (data[length - seam + i] as number) * (1 - w);
    }
  }
  return { buffer, loopEnd: (length - seam) / ctx.sampleRate };
}

type BusNodes = { input: GainNode; level: GainNode };

export class AmbientPlayer {
  readonly composer: Composer;
  readonly beatSeconds: number;
  readonly barSeconds: number;
  /** When bar 0 starts, in the context's seconds. */
  readonly start: number;
  private readonly stage: Stage;
  private readonly volume: GainNode;
  private readonly hushGain: GainNode;
  private readonly mix: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly buses: Record<Bus, BusNodes>;
  private readonly lasting: AudioNode[] = [];
  private readonly padAmp: GainNode;
  private readonly padSwell: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly formants: [BiquadFilterNode, number, number][] = [];
  private readonly padVoices: {
    oscillators: { node: OscillatorNode; multiple: number }[];
    warmth: GainNode | null;
  }[] = [];
  private readonly waves: { low: BiquadFilterNode; wave: GainNode } | null = null;
  private padStarted = false;
  private padNow = Number.NaN;
  /** When the next bar starts, in the context's seconds. */
  private nextBarAt: number;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly style: Style,
    seed: number,
    options: {
      start?: number;
      volume?: number;
      destination?: AudioNode;
      analyser?: AnalyserNode;
    } = {},
  ) {
    this.composer = new Composer(style, seed);
    this.beatSeconds = 60 / style.bpm;
    this.barSeconds = this.beatSeconds * style.beats;
    this.start = options.start ?? ctx.currentTime + 0.1;
    this.nextBarAt = this.start;
    const keep = <T extends AudioNode>(node: T, ...more: AudioNode[]): T => {
      this.lasting.push(node, ...more);
      return node;
    };
    this.stage = {
      ctx,
      lastF: {},
      panned: (node, pan, to) => this.panned(node, pan, to),
      run: (sources, nodes, at, end) => {
        for (const source of sources) {
          source.start(at);
          source.stop(end);
        }
        const last = sources[sources.length - 1];
        if (last)
          last.onended = () => {
            for (const node of [...sources, ...nodes]) node.disconnect();
          };
      },
    };

    this.volume = keep(ctx.createGain());
    this.volume.gain.setValueAtTime(0, this.start);
    this.volume.gain.linearRampToValueAtTime(FULL * (options.volume ?? 0.4), this.start + 3);
    this.hushGain = keep(ctx.createGain());
    const rumble = keep(ctx.createBiquadFilter());
    rumble.type = "highpass";
    rumble.frequency.value = 32;
    const tone = keep(ctx.createBiquadFilter());
    tone.type = "lowpass";
    tone.frequency.value = 11000;
    tone.Q.value = 0.4;
    const glue = keep(ctx.createDynamicsCompressor());
    glue.threshold.value = -18;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.02;
    glue.release.value = 0.3;
    this.mix = keep(ctx.createGain());
    this.mix.gain.value = 10 ** (style.trim / 20);
    if (style.tilt) {
      const tilt = keep(ctx.createBiquadFilter());
      tilt.type = "highshelf";
      tilt.frequency.value = 1400;
      tilt.gain.value = style.tilt;
      this.mix.connect(tilt).connect(tone);
    } else this.mix.connect(tone);
    tone.connect(rumble).connect(glue).connect(this.hushGain);
    // Read the mix before volume so the mark can apply the slider exactly once.
    if (options.analyser) this.hushGain.connect(options.analyser).connect(this.volume);
    else this.hushGain.connect(this.volume);
    this.volume.connect(options.destination ?? ctx.destination);

    this.reverb = keep(ctx.createConvolver());
    this.reverb.buffer = impulse(ctx, seed, style.reverb);
    const wet = keep(ctx.createGain());
    wet.gain.value = style.wet;
    this.reverb.connect(wet).connect(this.mix);

    const echoIn = style.echo ? this.echo(style.echo, keep) : null;

    const buses = {} as Record<Bus, BusNodes>;
    for (const name of [...LAYERS, "cue"] as const) {
      const [lowpass, toReverb, toEcho] = style.buses[name] ?? BUS_DEFAULTS[name];
      const input = keep(ctx.createGain());
      input.gain.value = 10 ** ((style.gains[name] ?? 0) / 20);
      const level = keep(ctx.createGain());
      level.gain.value = name === "cue" ? 0.9 : 0;
      const filter = keep(ctx.createBiquadFilter());
      filter.type = "lowpass";
      filter.Q.value = 0.5;
      filter.frequency.value = Math.min(11000, lowpass);
      input.connect(level).connect(filter).connect(this.mix);
      if (toReverb > 0) {
        const send = keep(ctx.createGain());
        send.gain.value = toReverb;
        filter.connect(send).connect(this.reverb);
      }
      if (toEcho > 0 && echoIn) {
        const send = keep(ctx.createGain());
        send.gain.value = toEcho;
        filter.connect(send).connect(echoIn);
      }
      buses[name] = { input, level };
    }
    this.buses = buses;

    // The pad: one long voice that moves from chord to chord.
    const pad = style.pad;
    const timbre = pad.timbre;
    this.padAmp = keep(ctx.createGain());
    this.padAmp.gain.value = pad.amp;
    this.padSwell = keep(ctx.createGain());
    this.padFilter = keep(ctx.createBiquadFilter());
    this.padFilter.type = "lowpass";
    this.padFilter.frequency.value = timbre.f[0];
    this.padFilter.Q.value = timbre.q;
    let padIn: AudioNode = this.padFilter;
    if (timbre.formants) {
      const into = keep(ctx.createGain());
      padIn = into;
      for (const [calm, working, q, gain] of timbre.formants) {
        const band = keep(ctx.createBiquadFilter());
        band.type = "bandpass";
        band.frequency.value = calm;
        band.Q.value = q;
        const level = keep(ctx.createGain());
        level.gain.value = gain * 2.2;
        into.connect(band).connect(level).connect(this.padFilter);
        this.formants.push([band, calm, working]);
      }
    }
    this.padFilter.connect(this.padAmp).connect(this.padSwell).connect(this.buses.pad.input);
    const drifts = (pad.drift ?? [[0.21, 3]]).map(([hz, cents]) => {
      const lfo = keep(ctx.createOscillator());
      lfo.frequency.value = hz;
      const depth = keep(ctx.createGain());
      depth.gain.value = cents;
      lfo.connect(depth);
      lfo.start(this.start);
      return depth;
    });
    if (pad.wobble) {
      // A slow sweep of the filter, the drone's buzz moving.
      const lfo = keep(ctx.createOscillator());
      lfo.frequency.value = pad.wobble[0];
      const depth = keep(ctx.createGain());
      depth.gain.value = pad.wobble[1];
      lfo.connect(depth).connect(this.padFilter.frequency);
      lfo.start(this.start);
    }
    for (let k = 0; k < style.pad.anchors.length; k += 1) {
      const oscillators = timbre.osc.map(([type, cents, gain, pan, multiple]) => {
        const node = keep(ctx.createOscillator());
        node.type = type;
        node.detune.value = cents;
        for (const depth of drifts) depth.connect(node.detune);
        const level = keep(ctx.createGain());
        level.gain.value = gain;
        node.connect(level);
        keep(this.panned(level, pan, padIn));
        return { node, multiple };
      });
      let warmth: GainNode | null = null;
      if (timbre.warm) {
        const [type, cents, multiple] = timbre.warm;
        const saw = keep(ctx.createOscillator());
        saw.type = type;
        saw.detune.value = k === 1 ? cents : -cents;
        warmth = keep(ctx.createGain());
        warmth.gain.value = 0;
        saw.connect(warmth);
        keep(this.panned(warmth, (k - 1) * 0.4, padIn));
        oscillators.push({ node: saw, multiple });
      }
      this.padVoices.push({ oscillators, warmth });
    }

    // The sea's wash, the one sound made of noise, under a sea style alone.
    if (style.sea) {
      const { buffer, loopEnd } = wash(ctx, seed);
      const source = keep(ctx.createBufferSource());
      source.buffer = buffer;
      source.loop = true;
      source.loopEnd = loopEnd;
      const low = keep(ctx.createBiquadFilter());
      low.type = "lowpass";
      low.frequency.value = 600;
      low.Q.value = 0.3;
      const high = keep(ctx.createBiquadFilter());
      high.type = "highpass";
      high.frequency.value = 140;
      const wave = keep(ctx.createGain());
      wave.gain.value = 0.2;
      const level = keep(ctx.createGain());
      level.gain.value = 0;
      level.gain.setTargetAtTime(WAVES, this.start, 0.3);
      source.connect(low).connect(high).connect(wave).connect(level).connect(this.mix);
      const send = keep(ctx.createGain());
      send.gain.value = 0.25;
      level.connect(send).connect(this.reverb);
      source.start(this.start);
      this.waves = { low, wave };
    }
  }

  /** Sets how loud it plays, 0..1, over a moment. */
  setVolume(volume: number): void {
    this.volume.gain.cancelScheduledValues(this.ctx.currentTime);
    this.volume.gain.setTargetAtTime(FULL * volume, this.ctx.currentTime, 0.1);
  }

  /**
   * Silences it within 150 ms, or brings it back over about a second.
   * Voice input listening, a card's sound clip and a demo with sound hush it.
   */
  hush(on: boolean, at = this.ctx.currentTime): void {
    const gain = this.hushGain.gain;
    gain.cancelAndHoldAtTime(at);
    if (on) gain.linearRampToValueAtTime(0, at + HUSH_SECONDS);
    else gain.setTargetAtTime(1, at, 0.35);
  }

  /**
   * Composes and schedules every bar that starts before `until`, at the crew level now.
   * Bars whose start already passed, after a stalled window or slowed timers, are
   * skipped, leaving a gap rather than starting their notes all at once.
   */
  scheduleUntil(until: number, level: CrewLevel): Bar[] {
    const bars: Bar[] = [];
    const now = this.ctx.currentTime;
    if (this.nextBarAt < now)
      this.nextBarAt += Math.ceil((now - this.nextBarAt) / this.barSeconds) * this.barSeconds;
    while (this.nextBarAt < until) {
      const bar = this.composer.bar(level);
      this.play(bar, this.nextBarAt);
      bars.push(bar);
      this.nextBarAt += this.barSeconds;
    }
    return bars;
  }

  /** A card landed unseen: the waiting chime on the next beat, at most once every two bars. */
  waiting(at = this.ctx.currentTime): void {
    const beat = this.nextBeat(at);
    const notes = this.composer.waiting(Math.floor((beat - this.start) / this.barSeconds));
    if (notes) for (const note of notes) this.note(note, beat);
  }

  /** A task merged: a rising run on the next beat, and the next chords resolve. */
  merged(at = this.ctx.currentTime): void {
    const beat = this.nextBeat(at);
    for (const note of this.composer.merged()) this.note(note, beat);
  }

  /** Disconnects every node; nothing plays after it. */
  stop(): void {
    for (const node of this.lasting) {
      if (node instanceof AudioScheduledSourceNode) {
        try {
          node.stop();
        } catch {
          // A pad voice that never started, before the first bar.
        }
      }
      node.disconnect();
    }
  }

  /** Two delays feeding each other, one each side; returns where a bus sends into it. */
  private echo(
    e: NonNullable<Sound["echo"]>,
    keep: <T extends AudioNode>(node: T, ...more: AudioNode[]) => T,
  ): GainNode {
    const ctx = this.ctx;
    const input = keep(ctx.createGain());
    const left = keep(ctx.createDelay(3));
    const right = keep(ctx.createDelay(3));
    left.delayTime.value = e.beats * this.beatSeconds;
    right.delayTime.value = e.beats * this.beatSeconds;
    const damp = keep(ctx.createBiquadFilter());
    damp.type = "lowpass";
    damp.frequency.value = e.lp;
    const toRight = keep(ctx.createGain());
    const toLeft = keep(ctx.createGain());
    toRight.gain.value = e.fb;
    toLeft.gain.value = e.fb;
    input.connect(left);
    left.connect(toRight).connect(damp).connect(right);
    right.connect(toLeft).connect(left);
    const out = keep(ctx.createGain());
    out.gain.value = e.mix;
    const leftPan = keep(ctx.createStereoPanner());
    leftPan.pan.value = -0.55;
    const rightPan = keep(ctx.createStereoPanner());
    rightPan.pan.value = 0.55;
    left.connect(leftPan).connect(out);
    right.connect(rightPan).connect(out);
    out.connect(this.mix);
    const toReverb = keep(ctx.createGain());
    toReverb.gain.value = 0.3;
    out.connect(toReverb).connect(this.reverb);
    return input;
  }

  private nextBeat(at: number): number {
    const lead = Math.max(at + 0.05, this.start);
    return this.start + Math.ceil((lead - this.start) / this.beatSeconds) * this.beatSeconds;
  }

  private play(bar: Bar, at: number): void {
    const ramp = this.barSeconds * 0.3;
    for (const layer of LAYERS)
      this.buses[layer].level.gain.setTargetAtTime(bar.layers[layer] || 0, at, ramp);
    this.glide(bar, at);
    for (const note of bar.notes) this.note(note, at);
    const pad = this.style.pad;
    const B = this.barSeconds;
    if (pad.swell) {
      // The bellows: each bar breathes in and out.
      this.padSwell.gain.setTargetAtTime(1, at, B * 0.16);
      this.padSwell.gain.setTargetAtTime(1 - pad.swell, at + B * 0.55, B * 0.22);
    }
    if (pad.tide && bar.index % 2 === 0) {
      // The tide: a swell every two bars.
      this.padSwell.gain.setTargetAtTime(1, at, B * 0.4);
      this.padSwell.gain.setTargetAtTime(1 - pad.tide, at + B * 0.95, B * 0.45);
    }
    if (this.waves && bar.index % 2 === 0) {
      // A wave every two bars: it rises and brightens, then draws back.
      const P = B * 2;
      this.waves.wave.gain.setTargetAtTime(1, at, P * 0.11);
      this.waves.wave.gain.setTargetAtTime(0.22, at + P * 0.36, P * 0.2);
      this.waves.low.frequency.setTargetAtTime(1500, at, P * 0.1);
      this.waves.low.frequency.setTargetAtTime(520, at + P * 0.36, P * 0.22);
    }
  }

  private glide(bar: Bar, at: number): void {
    const pad = this.style.pad;
    const timbre = pad.timbre;
    const heat = bar.heat;
    const dip = pad.dip && bar.newChord && this.padStarted;
    // A pad whose filter closes as it warms is lifted to keep its level.
    const amp = pad.amp * (1 + (timbre.lift || 0) * heat);
    if (dip) {
      this.padAmp.gain.setTargetAtTime(amp * (1 - (pad.dip as number)), at - 0.28, 0.09);
      this.padAmp.gain.setTargetAtTime(amp, at + 0.03, 0.3);
    } else if (amp !== this.padNow) this.padAmp.gain.setTargetAtTime(amp, at, 0.8);
    this.padNow = amp;
    this.padVoices.forEach((voice, k) => {
      const f = mtof(bar.pad[k] as number);
      for (const { node, multiple } of voice.oscillators) {
        if (!this.padStarted) node.frequency.setValueAtTime(f * multiple, at);
        else node.frequency.setTargetAtTime(f * multiple, at, dip ? 0.03 : pad.glide || 0.18);
      }
      if (voice.warmth && timbre.warm)
        voice.warmth.gain.setTargetAtTime(timbre.warm[3] * heat, at, 0.8);
    });
    this.padFilter.frequency.setTargetAtTime(timbre.f[0] + timbre.f[1] * heat, at, 0.8);
    for (const [band, calm, working] of this.formants)
      band.frequency.setTargetAtTime(calm + (working - calm) * heat, at, 0.8);
    if (!this.padStarted) {
      for (const voice of this.padVoices) for (const { node } of voice.oscillators) node.start(at);
      this.padStarted = true;
    }
  }

  private note(note: Note, barAt: number): void {
    const t = barAt + note.beat * this.beatSeconds;
    const length = note.length * this.beatSeconds;
    if (note.voice === "glow") {
      this.glow(note, t);
      return;
    }
    const voice = this.style.voices[note.voice];
    if (!voice) return;
    const db = voice[3];
    const played: Played = db
      ? { ...note, velocity: note.velocity * 10 ** (db / 20), touch: note.velocity }
      : note;
    const to = this.buses[voice[1]].input;
    const s = this.stage;
    switch (voice[0]) {
      case "fm":
        fm(s, played, t, length, to, voice[2]);
        break;
      case "pluck":
        pluck(s, played, t, length, to, voice[2]);
        break;
      case "mallet":
        mallet(s, played, t, length, to, voice[2]);
        break;
      case "glass":
        glass(s, played, t, length, to);
        break;
      case "sus":
        sus(s, played, t, length, to, voice[2], note.voice);
        break;
      case "bass":
        bass(s, played, t, length, to, voice[2]);
        break;
      case "drum":
        drum(s, played, t, to, voice[2]);
        break;
      case "wood":
        wood(s, played, t, to, voice[2]);
        break;
      case "tick":
        tick(s, played, t, to, voice[2]);
        break;
      case "piano":
        piano(s, played, t, length, to, voice[2]);
        break;
    }
  }

  /** Connects through a panner. */
  private panned(node: AudioNode, pan: number, to: AudioNode): StereoPannerNode {
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    node.connect(panner).connect(to);
    return panner;
  }

  /**
   * The waiting chime's held note: the notice pulse's own curve
   * (../character/notice.ts), its two halves spreading to both sides as
   * the ring of light does.
   */
  private glow(note: Note, t: number): void {
    const ctx = this.ctx;
    const seconds = (NOTICE_DURATION_MS / 1000) * GLOW_STRETCH;
    const steps = 64;
    const frames = Array.from({ length: steps }, (_, i) =>
      noticeFrame((i / (steps - 1)) * NOTICE_DURATION_MS * 0.999),
    );
    const strength = Float32Array.from(frames, (frame) => frame.strength * note.velocity);
    for (const side of [-1, 1]) {
      const oscillator = ctx.createOscillator();
      oscillator.frequency.value = mtof(note.midi) * (1 + side * 0.0015);
      const amp = ctx.createGain();
      amp.gain.value = 0;
      amp.gain.setValueCurveAtTime(strength, t, seconds);
      const panner = ctx.createStereoPanner();
      panner.pan.value = 0;
      panner.pan.setValueCurveAtTime(
        Float32Array.from(frames, (frame) => side * 0.85 * frame.spread),
        t,
        seconds,
      );
      oscillator.connect(amp).connect(panner).connect(this.buses.cue.input);
      this.stage.run([oscillator], [amp, panner], t, t + seconds + 0.05);
    }
  }
}
