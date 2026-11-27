import { band } from "./face";

// The sky fidgets - Orion, the Big Dipper, Saturn, a spiral galaxy and Algol
// (the captain's picks from the eleven-fidget prototype review, 2026-09-29):
// what the five modules share. Each is a one-shot fidget like the pretend
// black hole (./blackhole): the same wind-up / hold / unwind envelope, the
// same 16 vertices handed over by firstmatePainter.ts at their projected positions
// and moved into the figure by the envelope, the wires fading by each
// vertex's progress, and the eyes kept as the character's own.
//
// Everything here and in the five modules is DOM-free apart from the
// CanvasRenderingContext2D they paint.

/** Projected vertex: screen x, screen y, depth scale, 4D w. */
export type SkyPt = [number, number, number, number];

export type Rgb = [number, number, number];

/** The wind-up / hold / unwind envelope: the pretend black hole's. */
export const skyEnvelope = (et: number): number => band(et, 0.05, 0.25, 0.8, 0.17);

export type SkyColors = {
  acc: Rgb;
  dim: Rgb;
  hot: Rgb;
  bg: Rgb;
  /** Alpha multiplier from the theme. */
  boost: number;
};

/**
 * The restyle a sky fidget hands the host's dot pass, per vertex: a radius
 * multiplier (a star's magnitude), an alpha multiplier (a twinkle, a dot
 * hidden behind Saturn's globe) and how much of a white core the dot
 * carries (a blue-white star). The host resets all three every frame.
 */
export type SkyDots = {
  scale: Float64Array;
  fade: Float64Array;
  white: Float64Array;
};

export const WHITE: Rgb = [255, 246, 230];

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const rgba = (c: Rgb, a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a))})`;
