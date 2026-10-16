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
  /** A line about a task carries its key as a dim mono prefix. */
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
        ...style,
      }}
    >
      <span
        role="img"
        aria-label={kind}
        title={kind}
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: toneColors[tone],
        }}
      />
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
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
            textAlign: "right",
          }}
        >
          {time}
        </span>
      )}
    </div>
  );
}
