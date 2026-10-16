import { RISK_DIMENSIONS, RISK_WORDS, type RiskDimension } from "@shared/risk";

/**
 * The risk radar's geometry (FI3-1127's plan, round 8; design skill
 * ResponseCard "The risk chart"): a box as tall as the headline, Why and
 * What changed with one line each, as wide as its axis labels need, the
 * rings shrunk to leave every label's room on the outer ring whether it
 * shows or not. Pure numbers, so the chart and the body's spacer read one
 * box.
 */

/** The chart's height: from the headline's top through What changed. */
export const RISK_CHART_HEIGHT = 128;
/** The air between the chart's box and the headline and lines beside it. */
export const RISK_CHART_GAP = 16;
/** How far the outer ring sits inside the box's top and bottom: its labels' room. */
const RING_INSET = 24;
/** From the outer ring to a label's near edge. */
const LABEL_GAP = 11;
/** One character of an 11 px mono label: the face's advance is 0.6 em. */
const LABEL_CHAR = 6.6;
/** A label's baseline below its anchor point, by where it sits on the ring. */
const BELOW = 8;
const MIDDLE = 4;

export type RiskAxis = {
  dimension: RiskDimension;
  /** Degrees clockwise from the top. */
  angle: number;
  /** Where its label sits on the outer ring, and which way it reads. */
  label: { x: number; y: number; anchor: "start" | "middle" | "end" };
};

export type RiskRadarGeometry = {
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** The outer ring's radius: level three. */
  radius: number;
  axes: RiskAxis[];
};

const round = (n: number) => Math.round(n * 10) / 10;

/** A point `r` out from the centre along a bearing of `angle` degrees clockwise from the top. */
export function radarPoint(
  geometry: Pick<RiskRadarGeometry, "cx" | "cy">,
  r: number,
  angle: number,
): [number, number] {
  const t = ((angle - 90) * Math.PI) / 180;
  return [round(geometry.cx + r * Math.cos(t)), round(geometry.cy + r * Math.sin(t))];
}

/**
 * The radar's box and axes. A label on the right of the ring reads from its
 * axis end rightwards, one on the left ends there, one at the top or bottom
 * is centred; the box keeps each label's whole width beside its axis end, so
 * no label on the outer ring ever leaves it.
 */
export function riskRadarGeometry(
  dimensions: readonly RiskDimension[] = RISK_DIMENSIONS,
  height = RISK_CHART_HEIGHT,
): RiskRadarGeometry {
  const radius = height / 2 - RING_INSET;
  const n = dimensions.length;
  let left = radius + 6;
  let right = radius + 6;
  const bearings = dimensions.map((dimension, index) => {
    const angle = (index * 360) / n;
    const t = ((angle - 90) * Math.PI) / 180;
    const cos = Math.cos(t);
    const x = (radius + LABEL_GAP) * cos;
    const width = RISK_WORDS[dimension].label.length * LABEL_CHAR;
    if (cos > 0.2) right = Math.max(right, x + width);
    else if (cos < -0.2) left = Math.max(left, -x + width);
    else {
      left = Math.max(left, width / 2);
      right = Math.max(right, width / 2);
    }
    return { dimension, angle, cos, sin: Math.sin(t) };
  });
  const cx = Math.ceil(left + 2);
  const cy = height / 2;
  const width = Math.ceil(left + right + 4);
  const axes = bearings.map(({ dimension, angle, cos, sin }) => {
    const [x, y] = radarPoint({ cx, cy }, radius + LABEL_GAP, angle);
    const anchor: RiskAxis["label"]["anchor"] = cos > 0.2 ? "start" : cos < -0.2 ? "end" : "middle";
    const drop = sin > 0.2 ? BELOW : sin < -0.2 ? 0 : MIDDLE;
    return { dimension, angle, label: { x, y: round(y + drop), anchor } };
  });
  return { width, height, cx, cy, radius, axes };
}
