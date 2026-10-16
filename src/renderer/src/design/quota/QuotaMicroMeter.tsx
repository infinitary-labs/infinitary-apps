import type React from "react";
import { useRestLabel } from "../core/restLabel";
import type { QuotaPace } from "./QuotaMeter";

export type QuotaMicroMeterProps = {
  /** Window label, e.g. "session", "weekly (Opus)". Never truncated. */
  label: string;
  /** 0-100; undefined renders "–" (an unread window is never 0). */
  percentRemaining?: number;
  pace?: QuotaPace;
  /**
   * Rides the label the app draws on rest, the pointer's or the keyboard's
   * focus, and the meter's accessible name; the row has no room for it.
   */
  resetText?: string;
  /** The linear-pace clock marker (quota-axi's ┃), as on QuotaMeter. */
  clockPercent?: number;
  /** A last-known-good reading: dims the bar and number, drops the tint. */
  stale?: boolean;
  style?: React.CSSProperties;
};

/**
 * The instrument form of QuotaMeter (design skill QuotaMicroMeter): label ·
 * 56px bar · percent on ONE line, so an account's every window sits side by
 * side and the eye reads the low bar. Same tone rules as QuotaMeter - ≤10%
 * forces danger, "ahead" (burning faster than the reset clock) warns,
 * "behind" is calm - plus a percent tint below 50 (warn) and 20 (danger). A
 * stale reading keeps its raw number but dims to tertiary: a last-known-good
 * is never current headroom, and the host says its age in the verdict slot.
 */
/**
 * The meter's accessible name: its window, what is left and when it resets
 * (`session 74% left · resets 3pm`), since the bar and its words are one
 * picture to assistive technology.
 */
export function quotaMeterName(label: string, percentRemaining?: number, resetText?: string) {
  const left =
    typeof percentRemaining === "number" ? `${Math.round(percentRemaining)}% left` : "not read";
  return [`${label} ${left}`, resetText].filter(Boolean).join(" · ");
}

const paceColors: Record<QuotaPace, string> = {
  ahead: "var(--warn)",
  on_pace: "var(--accent)",
  behind: "var(--ok)",
  unknown: "var(--idle)",
};

export function QuotaMicroMeter({
  label,
  percentRemaining,
  pace = "unknown",
  resetText,
  clockPercent,
  stale = false,
  style,
}: QuotaMicroMeterProps) {
  const known = typeof percentRemaining === "number";
  const low = known && percentRemaining <= 10;
  const color = stale ? "var(--idle)" : low ? "var(--danger)" : paceColors[pace];
  const clock =
    typeof clockPercent === "number" ? Math.max(0, Math.min(100, clockPercent)) : undefined;
  const percentColor =
    stale || !known
      ? "var(--fg-3)"
      : percentRemaining < 20
        ? "var(--danger)"
        : percentRemaining < 50
          ? "var(--warn)"
          : "var(--fg-1)";
  const fill = known ? Math.max(0, Math.min(100, percentRemaining)) : 0;
  // The reset time is a fact the row has no room for: the meter is a Tab
  // stop of its own that shows it on rest, as the pointer's rest does
  // (docs/keyboard.md, "Facts shown on rest").
  const rest = useRestLabel(resetText ? `${label} · ${resetText}` : undefined, { fact: true });
  return (
    <span
      data-testid="quota-micro-meter"
      data-stale={stale ? "true" : undefined}
      role="img"
      aria-label={quotaMeterName(label, percentRemaining, resetText)}
      tabIndex={resetText ? 0 : undefined}
      {...rest}
      style={{
        display: "inline-grid",
        gridTemplateColumns: "auto 56px auto",
        alignItems: "center",
        gap: 7,
        minWidth: 0,
        borderRadius: "var(--radius-s)",
        ...style,
      }}
    >
      {/* The label never truncates: it is what tells two bars apart. */}
      <span
        style={{
          fontSize: "var(--text-xs)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--fg-3)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span
        style={{
          position: "relative",
          display: "block",
          height: 3,
          borderRadius: 2,
          background: "var(--bg-3)",
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${fill}%`,
            borderRadius: 2,
            background: color,
            opacity: stale ? 0.4 : 1,
            transition: "width var(--dur-slow) var(--ease-drift)",
          }}
        />
        {clock !== undefined && (
          <span
            data-testid="quota-clock-marker"
            style={{
              position: "absolute",
              top: -2,
              bottom: -2,
              left: `${clock}%`,
              width: 1,
              background: "var(--fg-3)",
            }}
          />
        )}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: percentColor,
          whiteSpace: "nowrap",
        }}
      >
        {known ? `${Math.round(percentRemaining)}%` : "–"}
      </span>
    </span>
  );
}
