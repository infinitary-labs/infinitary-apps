import type React from "react";
import { useState } from "react";
import { StatusDot, type StatusDotTone } from "../core/StatusDot";

export type RowProps = {
  /** One line, ellipsized; never wrapped (design skill NowPanel). */
  title: string;
  /** What the row's subject is doing, in StatusDot's language. */
  tone?: StatusDotTone;
  /** The dot's accessible name; the dot carries no other text. */
  toneLabel?: string;
  /** Exactly one dim word after the title ("blocked", "held"). */
  word?: string;
  /** The trailing datum - a key, a count, a time - rendered in dim mono. */
  trailing?: React.ReactNode;
  depth?: number;
  /** The row whose detail is open beside the panel: accent-tinted, no border. */
  selected?: boolean;
  /** A click is a POINTING gesture, never a write. Omit for a display row. */
  onClick?: () => void;
  /** For a list that is one Tab stop with the arrows inside it: the row's place in that order. */
  tabIndex?: number;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
  /** What a screen reader says for the whole row, when the title alone is not enough. */
  ariaLabel?: string;
  style?: React.CSSProperties;
};

const INDENT_PX = 12;

/**
 * The panel list row (design skill `components/now/NowPanel`, the row the
 * now panel paints): a StatusDot, the title, and one trailing datum in dim
 * mono. Everything richer hides behind a click. This is the row every
 * panel's list is built from, so a personal panel's list reads exactly like
 * the app's own.
 */
export function Row({
  title,
  tone = "ring",
  toneLabel,
  word,
  trailing,
  depth = 0,
  selected = false,
  onClick,
  tabIndex,
  onKeyDown,
  onFocus,
  ariaLabel,
  style,
}: RowProps) {
  const [hover, setHover] = useState(false);
  const interactive = onClick !== undefined;
  const background = selected
    ? "var(--accent-dim)"
    : hover && interactive
      ? "var(--bg-3)"
      : "transparent";
  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "6px minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: 8,
    width: "100%",
    boxSizing: "border-box",
    margin: 0,
    padding: "5px 6px",
    paddingInlineStart: 6 + depth * INDENT_PX,
    border: "none",
    borderRadius: "var(--radius-s)",
    background,
    color: "inherit",
    font: "inherit",
    fontWeight: 400,
    textAlign: "start",
    cursor: interactive ? "pointer" : "default",
    transition: "background var(--dur-fast) var(--ease-out)",
    ...style,
  };
  const body = (
    <>
      <StatusDot tone={tone} label={toneLabel ?? tone} />
      <span
        style={{
          fontSize: "var(--text-sm)",
          color: selected ? "var(--fg-1)" : "var(--fg-2)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          lineHeight: "var(--leading-body)",
        }}
      >
        {title}
        {word !== undefined && <span style={{ color: "var(--fg-3)" }}> {word}</span>}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: selected ? "var(--fg-2)" : "var(--fg-3)",
          whiteSpace: "nowrap",
        }}
      >
        {trailing}
      </span>
    </>
  );
  if (!interactive) {
    return <div style={rowStyle}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      aria-label={ariaLabel}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={rowStyle}
    >
      {body}
    </button>
  );
}
