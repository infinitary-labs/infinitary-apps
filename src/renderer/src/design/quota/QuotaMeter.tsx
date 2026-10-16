import type React from "react";

export type QuotaPace = "ahead" | "on_pace" | "behind" | "unknown";

export type QuotaMeterProps = {
  label?: string;
  /** 0-100; undefined renders as "no data". */
  percentRemaining?: number;
  pace?: QuotaPace;
  resetText?: string;
  /**
   * The linear-pace clock marker (quota-axi's ┃): the fill position of
   * exactly linear burn, i.e. the window's timeRemainingPercent. Fill
   * ending left of the marker means burning faster than the reset clock.
   * Omit when the window's pace is unknown.
   */
  clockPercent?: number;
  style?: React.CSSProperties;
};

/**
 * Pace semantics follow quota-axi (design skill QuotaMeter rule): "ahead"
 * is usage ahead of the reset clock - burning faster than linear, the
 * conserve signal - so it warns; "behind" is allowance building up, calm.
 */
const paceColors: Record<QuotaPace, string> = {
  ahead: "var(--warn)",
  on_pace: "var(--accent)",
  behind: "var(--ok)",
  unknown: "var(--idle)",
};

const paceLabels: Record<QuotaPace, string> = {
  ahead: "ahead",
  on_pace: "on pace",
  behind: "behind",
  unknown: "-",
};

export function QuotaMeter({
  label,
  percentRemaining,
  pace = "unknown",
  resetText,
  clockPercent,
  style,
}: QuotaMeterProps) {
  const known = typeof percentRemaining === "number";
  const low = known && percentRemaining <= 10;
  const color = low ? "var(--danger)" : paceColors[pace] || paceColors.unknown;
  const clock =
    typeof clockPercent === "number" ? Math.max(0, Math.min(100, clockPercent)) : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {/* The label holds its ground; a cramped host truncates the value's
          tail (the reset note) with an ellipsis instead of overlapping
          neighbors (design skill QuotaMeter rule). */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: 500,
            letterSpacing: "var(--tracking-label)",
            textTransform: "uppercase",
            color: "var(--fg-3)",
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: "var(--fg-2)",
            whiteSpace: "nowrap",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {known ? (
            <span style={{ color: "var(--fg-1)" }}>{Math.round(percentRemaining)}% left</span>
          ) : (
            "no data"
          )}
          {/* An unknown pace says nothing - no placeholder glyph. */}
          {known && (low || pace !== "unknown") && (
            <span>
              {" "}
              · <span style={{ color }}>{low ? "low" : paceLabels[pace]}</span>
            </span>
          )}
          {resetText && <span style={{ color: "var(--fg-3)" }}> · {resetText}</span>}
        </span>
      </div>
      <div style={{ position: "relative", height: 3, borderRadius: 2, background: "var(--bg-3)" }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 2, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${known ? percentRemaining : 0}%`,
              background: color,
              borderRadius: 2,
              transition: "width var(--dur-slow) var(--ease-drift)",
            }}
          />
        </div>
        {clock !== undefined && (
          <div
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
      </div>
    </div>
  );
}
