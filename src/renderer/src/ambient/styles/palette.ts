// The presets a person's own style may name (docs/ambient-music.md, "Your
// own styles"), by instrument, as src/shared/ambientOwn.ts lists them: the
// shipped styles' own sounds, and four more the first mate's samples asked
// for. A style names a preset; it never writes one.

import type { OwnInstrument } from "@shared/ambientOwn";
import type { FmPreset, MalletPreset, PianoPreset, PluckPreset, SusPreset } from "../instruments";
import type { Voice } from "../player";
import { DRUM, FM_CELESTA, HELD, MALLET, PLUCK, SHAKER, WOOD } from "./kit";
import { PIANO } from "./piano";

/** A soft electric piano: a bell-less FM tine. */
const EP: FmPreset = {
  ratio: 1,
  idx: 1.2,
  idxEnd: 0.1,
  idxT: 0.6,
  amp: 0.13,
  sus: 0.4,
  susTau: 0.6,
  rel: 0.3,
  tail: 1.4,
};
/** Vibraphone bars that ring on. */
const VIBES: MalletPreset = {
  partials: [
    [1, 1, 1],
    [4, 0.12, 0.25],
    [10, 0.02, 0.08],
  ],
  att: 0.004,
  amp: 0.14,
  ring: 1.8,
};
/** A singing bowl: its partials out of tune with each other, ringing for seconds. */
const BOWL: MalletPreset = {
  partials: [
    [1, 1, 1],
    [2.71, 0.3, 0.55],
    [5.15, 0.1, 0.25],
    [8.4, 0.03, 0.1],
  ],
  att: 0.03,
  amp: 0.5,
  ring: 9,
};

/** Each instrument's presets by name; null where the instrument plays its own sound. */
export const PALETTE = {
  piano: { felt: PIANO.felt, cold: PIANO.cold } satisfies Record<string, PianoPreset>,
  fm: { ep: EP, celesta: FM_CELESTA, chime: { ...FM_CELESTA, amp: 0.6, tail: 2.4 } },
  pluck: {
    guitar: PLUCK.guitar,
    harp: PLUCK.harp,
    uke: PLUCK.uke,
    lute: PLUCK.lute,
    pizz: PLUCK.pizz,
    seq: PLUCK.seq,
    upright: PLUCK.upright,
  } satisfies Record<string, PluckPreset>,
  mallet: {
    marimba: MALLET.marimba,
    vibes: VIBES,
    kalimba: MALLET.kalimba,
    musicbox: MALLET.musicbox,
    bell: MALLET.bell,
    handbell: MALLET.handbell,
    sonar: MALLET.sonar,
    bowl: BOWL,
  },
  sus: {
    flute: HELD.flute,
    whistle: HELD.whistle,
    noseflute: HELD.noseflute,
    theremin: HELD.theremin,
    synthLead: HELD.synthLead,
    fiddle: HELD.fiddle,
    reedLead: HELD.reedLead,
    bugle: HELD.bugle,
    conch: HELD.conch,
    sub: HELD.sub,
  } satisfies Record<string, SusPreset>,
  bass: { round: null },
  drum: DRUM,
  wood: WOOD,
  tick: { soft: null, shaker: SHAKER },
  glass: { glass: null },
} satisfies Record<OwnInstrument, Record<string, unknown>>;

/** The engine's voice for an instrument, a bus, a preset's name (or the first) and a level. */
export function paletteVoice(
  instrument: OwnInstrument,
  bus: Voice[1],
  preset: string | undefined,
  db: number | undefined,
): Voice {
  const presets = PALETTE[instrument] as Record<string, unknown>;
  const chosen = preset ?? (Object.keys(presets)[0] as string);
  if (!Object.hasOwn(presets, chosen)) throw new Error(`${instrument} has no preset ${chosen}`);
  return [instrument, bus, presets[chosen], db] as unknown as Voice;
}
