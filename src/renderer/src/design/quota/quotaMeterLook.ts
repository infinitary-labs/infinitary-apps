/** How a window is being spent against its reset clock, as `QuotaMeter` names it. */
export type QuotaMeterPace = "ahead" | "on_pace" | "behind" | "unknown";

/** A design token a meter part takes its color from: `var(--warn)` on the computer, the same token on the phone. */
export type QuotaMeterTone = "warn" | "accent" | "ok" | "idle" | "danger";
export type QuotaFigureTone = "fg-1" | "fg-3" | "warn" | "danger";

export type QuotaMicroMeterLook = {
  /** The bar's fill, 0-100; 0 for a window that was not read. */
  fill: number;
  /** The bar's color. */
  bar: QuotaMeterTone;
  /** The number's color. */
  figure: QuotaFigureTone;
  /** The number as written: "74%", or "–" for a window that was not read. */
  text: string;
  /** Where the reset clock's marker sits, 0-100, when the window has one. */
  clock?: number;
};

const PACE_TONES: Record<QuotaMeterPace, QuotaMeterTone> = {
  ahead: "warn",
  on_pace: "accent",
  behind: "ok",
  unknown: "idle",
};

/**
 * The micro meter's tone rules (design skill QuotaMicroMeter), apart from
 * its drawing so the phone's Intelligence page colors a window exactly as
 * the computer does: 10% or less forces danger, "ahead" (burning faster
 * than the reset clock) warns, "behind" is calm; the number tints below 50
 * (warn) and 20 (danger). A stale reading keeps its raw number and loses
 * every tint: a last-known-good is never current headroom.
 */
export function quotaMicroMeterLook(meter: {
  percentRemaining?: number | undefined;
  pace?: QuotaMeterPace | undefined;
  clockPercent?: number | undefined;
  stale?: boolean | undefined;
}): QuotaMicroMeterLook {
  const { percentRemaining, pace = "unknown", clockPercent, stale = false } = meter;
  const known = typeof percentRemaining === "number";
  const low = known && percentRemaining <= 10;
  return {
    fill: known ? Math.max(0, Math.min(100, percentRemaining)) : 0,
    bar: stale ? "idle" : low ? "danger" : PACE_TONES[pace],
    figure:
      stale || !known
        ? "fg-3"
        : percentRemaining < 20
          ? "danger"
          : percentRemaining < 50
            ? "warn"
            : "fg-1",
    text: known ? `${Math.round(percentRemaining)}%` : "–",
    ...(typeof clockPercent === "number"
      ? { clock: Math.max(0, Math.min(100, clockPercent)) }
      : {}),
  };
}
