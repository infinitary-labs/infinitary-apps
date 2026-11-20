import type { FmUsage } from "@shared/events";

// The token flicker: when a model request completes and its usage arrives
// (the `turn_end` FmEvent's `usage`), the character that spent it flickers
// for a moment, and the flicker's brightness follows the request's total
// token count. One side channel serves the Firstmate (the emoteSignal
// pattern: a module queue the character drains on its next frame); a
// crewmate's rides its orbit member (./crew/orbit.ts `flicker`). The mapping
// and the envelope live here so both painters read the same curve.
//
// A filament, not a floodlight (captain's board review, 2026-09-23): the
// lift lands on the wires themselves - each edge's alpha and white-hot core
// wavering on its own phase, like a dim bulb's filament - while only a
// whisper (`glowSpill`) reaches the halo. The envelope is a fast rise and a
// damped oscillation: light wavering as it settles, not a flash on/off.
// With no flicker playing every painter computes exactly what it did before
// the flicker existed, so the resting character is unchanged.

export type FlickerTuning = {
  /** Totals at or below this map to minBoost; at or above, to maxBoost. */
  tokenMin: number;
  tokenMax: number;
  /** Brightness lift at tokenMin / tokenMax. */
  minBoost: number;
  maxBoost: number;
  /** How long one flicker plays, in ms. */
  durationMs: number;
  /** Damped brightness oscillations across the decay - the "flicker". */
  pulses: number;
  /** Oscillation depth, 0..1 (0 = a smooth bloom, 1 = dips to dark). */
  depth: number;
  /** How much of the flicker reaches the halo and ambient glow rather than
   *  the wires, 0..1 - 0 is a bare filament, 1 floods the glass. */
  glowSpill: number;
};

/**
 * The captain's tuning, picked on the review board: a LOG mapping over
 * 100-500k tokens, because totals span three orders of magnitude (a short
 * answer is a few hundred, a cache-heavy crewmate request passes 100k) and
 * only a log scale keeps the small end visible without flattening the top.
 */
export const FLICKER_TUNING: FlickerTuning = {
  tokenMin: 100,
  tokenMax: 500_000,
  minBoost: 0.1,
  maxBoost: 1.4,
  durationMs: 2000,
  pulses: 4,
  depth: 1,
  glowSpill: 0.12,
};

/** The request's total token count: every token field the usage carries. */
export function usageTotal(usage: FmUsage): number {
  return (
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
}

/**
 * A request's flicker strength, minBoost..maxBoost: its position in the log
 * domain between tokenMin and tokenMax, so equal ratios read as equal steps.
 */
export function tokenIntensity(total: number, t: FlickerTuning = FLICKER_TUNING): number {
  const min = Math.max(1, t.tokenMin);
  const max = Math.max(min + 1, t.tokenMax);
  const l0 = Math.log(min);
  const l1 = Math.log(max);
  const k = (Math.log(Math.max(min, total)) - l0) / (l1 - l0);
  return t.minBoost + (t.maxBoost - t.minBoost) * Math.min(1, Math.max(0, k));
}

/**
 * The flicker shape: fast rise (~7% of the duration), then a decay with
 * `pulses` damped oscillations of `depth` - a light wavering out, not a
 * square-wave blink. Returns 0 outside [0, durationMs).
 */
export function flickerEnvelope(ageMs: number, t: FlickerTuning = FLICKER_TUNING): number {
  if (!(ageMs >= 0)) return 0;
  const u = ageMs / Math.max(1, t.durationMs);
  if (u >= 1) return 0;
  const attack = u < 0.07 ? (u / 0.07) * (u / 0.07) * (3 - (2 * u) / 0.07) : 1;
  const decay = (1 - u) ** 1.7;
  const osc = 1 + t.depth * Math.sin(u * t.pulses * Math.PI * 2) * (1 - u);
  return attack * decay * osc;
}

/**
 * Per-wire unsteadiness inside a flicker: each edge runs its own phase plus
 * a second harmonic, so the lift reads as a filament wavering along the
 * wire - uneven, slightly erratic - never a uniform dimmer. ~0.16..1.08.
 */
export function filamentWaver(i: number, nowMs: number): number {
  return 0.62 + 0.34 * Math.sin(nowMs / 103 + i * 2.17) + 0.12 * Math.sin(nowMs / 41 + i * 4.91);
}

/**
 * The strength a new flicker starts from when one is still playing: the
 * incoming strength, or whatever the outgoing flicker still has - a small
 * request landing inside a big one's decay never visibly dims the rig.
 */
export function flickerMerge(at: number, boost: number, strength: number, now: number): number {
  return Math.max(strength, flickerEnvelope(now - at) * boost);
}

// ---- the Firstmate's flicker channel (the emoteSignal pattern) ----

const pendingFirstmate: number[] = [];

/**
 * A Firstmate request completed: queue one flicker of `strength`. A pile-up
 * between frames keeps the newest handful, never a backlog of stale flashes.
 */
export function requestFirstmateFlicker(strength: number): void {
  if (pendingFirstmate.length >= 6) pendingFirstmate.shift();
  pendingFirstmate.push(strength);
}

/** The oldest queued flicker's strength, if any - drained by the character's frame loop. */
export function takeFirstmateFlicker(): number | undefined {
  return pendingFirstmate.shift();
}
