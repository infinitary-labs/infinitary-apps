// The Firstmate's side of a crew moment - what its own body does when it
// sends a crewmate out or a report comes home. Two small envelopes, DOM-free
// and time-injected like ../notice.ts, overlaying whatever state the
// character is in and changing none of them.
//
// Send-off: the eyes glance toward where the crewmate is going, the ambient
// glow lifts a touch, and the structure gives one small exhale at the
// moment of emission (a body letting something go - the recoil is the
// story, kept tiny). Receive: one quick lift of the glow, the character
// taking in what came back. Neither draws a ring: the ring is the "new
// card" notice and means only that.

import { band, clamp01, pulse } from "../face";

/** How long a send-off cue runs, in ms. */
export const SENDOFF_MS = 900;
/** How long a receive cue runs, in ms. */
export const RECEIVE_MS = 600;

export type SendoffFrame = {
  /** 0..1 pull of the gaze toward the departure direction. */
  look: number;
  /** 0..1 lift of the ambient glow. */
  glow: number;
  /** 0..1 outward breath of the structure, peaking at emission. */
  exhale: number;
};

const NO_SENDOFF: SendoffFrame = { look: 0, glow: 0, exhale: 0 };

/**
 * The send-off at `elapsedMs` since it was requested. The cue is asked for
 * SENDOFF_LEAD_MS before the spark leaves (../crew/orbit.ts), so the look
 * and the glow are already up when it does, and the exhale peaks then.
 */
export function sendoffFrame(elapsedMs: number, strength = 1): SendoffFrame {
  if (!(elapsedMs >= 0) || elapsedMs >= SENDOFF_MS) return NO_SENDOFF;
  const t = elapsedMs / SENDOFF_MS;
  const s = clamp01(strength);
  return {
    look: band(t, 0, 0.12, 0.55, 0.3) * s,
    glow: band(t, 0.04, 0.16, 0.5, 0.4) * s,
    exhale: pulse(t, 0.2, 0.32) * s,
  };
}

export type ReceiveFrame = {
  /** 0..1 lift of the ambient glow. */
  glow: number;
};

const NO_RECEIVE: ReceiveFrame = { glow: 0 };

/** The receive at `elapsedMs` since it was requested: a quick rise, an eased fade. */
export function receiveFrame(elapsedMs: number): ReceiveFrame {
  if (!(elapsedMs >= 0) || elapsedMs >= RECEIVE_MS) return NO_RECEIVE;
  const t = elapsedMs / RECEIVE_MS;
  const rise = 0.2;
  return { glow: t < rise ? t / rise : (1 - (t - rise) / (1 - rise)) ** 2 };
}
