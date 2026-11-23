import type React from "react";

/**
 * The line's kind color, in the feed's language: neutral is the quiet
 * default, `you` is the captain's own violet, and ok/warn/danger are real
 * state (never decoration).
 */
export type FeedLineTone = "neutral" | "info" | "ok" | "warn" | "danger" | "you";

export type FeedLineProps = {
  /** What happened, in one factual sentence. Truncates to one line. */
  children?: React.ReactNode;
  /** The semantic kind, exposed as the dot's accessible label. */
  kind?: string;
  /** Relative age, already formatted ("4m", "2h"). Mono. */
  time?: string;
  taskKey?: string;
  tone?: FeedLineTone;
  style?: React.CSSProperties;
};

const toneColors: Record<FeedLineTone, string> = {
  neutral: "var(--fg-3)",
  info: "var(--fg-2)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  you: "var(--captain)",
};

/**
 * One line of a chromeless event log (design skill
 * `components/mate/ActivityFeed`): a semantic kind dot at the far left, the
 * text, and relative age at the right. No container or background - a feed
 * is a thread, not a list of cards. Stack lines oldest to newest with the
 * newest at the bottom.
 */
export function FeedLine({
  children,
  kind,
  time,
  taskKey,
  tone = "neutral",
  style,
}: FeedLineProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "5px minmax(0, 1fr) 32px",
        columnGap: "var(--space-3)",
        alignItems: "center",
        // The words and the age are trimmed to their letters, so the row
        // keeps one line's height itself.
        minHeight: "calc(var(--text-sm) * var(--leading-body))",
        ...style,
      }}
    >
      {/* The line's words say what its color does: no stop, nothing on rest. */}
      <span
        role="img"
        aria-label={kind}
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: toneColors[tone],
        }}
      />
      {/* Each run is trimmed to its x-height, so the grid centres its
          letters on the dot rather than its line box (design skill readme,
          Type: one line beside a dot or an icon). Cut sideways only, so
          the descenders below the trimmed box stay drawn. */}
      <span
        style={{
          minWidth: 0,
          overflowX: "clip",
          textBox: "trim-both ex alphabetic",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
          lineHeight: "var(--leading-body)",
        }}
      >
        {taskKey !== undefined && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
            }}
          >
            {taskKey}{" "}
          </span>
        )}
        {children}
      </span>
      {time !== undefined && (
        <span
          style={{
            color: "var(--fg-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: "var(--leading-body)",
            textBox: "trim-both ex alphabetic",
            textAlign: "end",
          }}
        >
          {time}
        </span>
      )}
    </div>
  );
}
