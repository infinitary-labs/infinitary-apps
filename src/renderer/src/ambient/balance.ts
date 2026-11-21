// The loudness of a person's own style (docs/ambient-music.md, "Your own
// styles"), set by the app, never the model: each layer is rendered alone,
// silently and faster than it plays, and moved to the level the shipped
// styles' same layer plays at; then the whole mix is moved to theirs.

import type { OwnStyle } from "@shared/ambientOwn";
import { type Bus, type CrewLevel, LAYERS, type Layer } from "./composer";
import { loudness } from "./loudness";
import { type Balance, loudestLevel, ownNeedsBalance, styleFromOwn } from "./own";
import { AmbientPlayer, type Style } from "./player";

/**
 * Each layer's loudness alone across the ten shipped styles, and their
 * whole mix at each crew level, in LUFS: the medians of renders of every
 * shipped style (INF-5541's measurements), rendered as `measure` renders.
 */
export const SHIPPED_LOUDNESS: { layers: Record<Layer, number>; mix: [number, number, number] } = {
  layers: {
    pad: -25.1,
    keys: -22.8,
    bass: -17.9,
    kick: -25.4,
    rim: -36.3,
    tick: -50.1,
    lead: -27,
    star: -44.8,
    arp: -29,
  },
  mix: [-18.1, -16.8, -16.0],
};

/** The rate the window plays at (./ambient.ts), so a render hears what plays. */
const RATE = 24_000;
/** How long each render runs, and how much of its start is left unheard while the volume rises. */
const SECONDS = 30;
const SKIP = 6;
/** How far one layer may move, in dB: a layer further off is a fault in its settings, not its level. */
const REACH = 24;
/** The highest sample may come to this, in dB. */
const PEAK = -1;
/** One seed for every render, so the same style measures the same. */
const SEED = 7;

/** Renders a style silently, faster than it plays, and measures it. */
export async function measure(
  style: Style,
  level: CrewLevel,
  solo?: Bus,
): Promise<{ lufs: number; peak: number }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(SECONDS * RATE), RATE);
  const player = new AmbientPlayer(ctx, style, SEED, {
    start: 0.1,
    volume: 1,
    ...(solo ? { solo } : {}),
  });
  player.scheduleUntil(SECONDS, level);
  const buffer = await ctx.startRendering();
  player.stop();
  return loudness([buffer.getChannelData(0), buffer.getChannelData(1)], RATE, SKIP);
}

/** Each layer's buses a style plays, and where each plays loudest. */
function layersPlayed(style: Style): [Layer, CrewLevel][] {
  const buses = new Set<Bus>(Object.values(style.voices).map((voice) => voice[1]));
  buses.add("pad");
  return LAYERS.flatMap((layer) => {
    const at = buses.has(layer) ? loudestLevel(style, layer) : null;
    return at === null ? [] : [[layer, at] as [Layer, CrewLevel]];
  });
}

/**
 * The balance a style plays at. A style that brings no voices of its own
 * keeps the layers of the shipped style it starts from, so only its whole
 * mix is measured.
 */
export async function balanceOwn(own: OwnStyle): Promise<Balance> {
  // Each layer measured without the person's own tilt of the mix, which goes on top.
  const flat = styleFromOwn({ ...own, mix: undefined });
  const gains: Partial<Record<Bus, number>> = {};
  if (ownNeedsBalance(own))
    for (const [layer, level] of layersPlayed(flat)) {
      const { lufs } = await measure(flat, level, layer);
      if (Number.isFinite(lufs))
        gains[layer] = Math.max(-REACH, Math.min(REACH, SHIPPED_LOUDNESS.layers[layer] - lufs));
    }
  const layered = styleFromOwn(own, { gains, trim: 0 });
  const middle = await measure(layered, 1);
  let trim = Number.isFinite(middle.lufs) ? SHIPPED_LOUDNESS.mix[1] - middle.lufs : 0;
  const busiest = await measure(styleFromOwn(own, { gains, trim }), 2);
  if (busiest.peak > PEAK) trim -= busiest.peak - PEAK;
  return { gains, trim };
}

/** Balances already measured this session, by the style's settings. */
const measured = new Map<string, Promise<Balance>>();

/** The balance for a style, measured once a session for the same settings. */
export function balanceFor(own: OwnStyle): Promise<Balance> {
  const key = JSON.stringify(own);
  let found = measured.get(key);
  if (!found) {
    found = balanceOwn(own);
    measured.set(key, found);
    found.catch(() => measured.delete(key));
  }
  return found;
}
