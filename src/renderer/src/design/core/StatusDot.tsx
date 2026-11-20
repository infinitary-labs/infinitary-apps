import type React from "react";
import { useRestLabel } from "./restLabel";

export type StatusDotTone = "ok" | "ring" | "warn" | "danger" | "idle" | "busy" | "captain";

export type StatusDotProps = {
  /**
   * ok = signed in with a reading · ring = signed in, nothing read yet ·
   * warn = a stale last-known-good · danger = sign in again · idle = paused ·
   * busy = work in flight on this row (ember, the working crewmate's heat) ·
   * captain = the captain's own hold on this row (violet: a task's browser
   * while he has control of it).
   */
  tone?: StatusDotTone;
  /** Accessible name, and the tooltip unless the caller already shows the same words. */
  label: string;
  /** False only where an audited caller already shows this exact state. */
  nativeTitle?: boolean;
  /**
   * The dot is a Tab stop of its own, and its words show in the label the
   * app draws on rest, the pointer's or the keyboard's focus, instead of the
   * native title: for a row whose state the dot alone says (docs/keyboard.md,
   * "Facts shown on rest"). Never inside a control, which names it already.
   */
  focusable?: boolean;
  style?: React.CSSProperties;
};

const fills: Record<Exclude<StatusDotTone, "ring">, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  idle: "var(--idle)",
  busy: "var(--hot)",
  captain: "var(--captain)",
};

/**
 * One 6px dot per list row in place of a status Badge (design skill
 * StatusDot): the calm way to say "signed in" eleven times on one screen.
 */
export function StatusDot({
  tone = "ring",
  label,
  nativeTitle = true,
  focusable = false,
  style,
}: StatusDotProps) {
  const ring = tone === "ring";
  const rest = useRestLabel(focusable && nativeTitle ? label : undefined, { fact: true });
  return (
    <span
      role="img"
      aria-label={label}
      title={nativeTitle && !focusable ? label : undefined}
      tabIndex={focusable && nativeTitle ? 0 : undefined}
      {...(focusable ? rest : {})}
      data-tone={tone}
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        flexShrink: 0,
        boxSizing: "border-box",
        background: ring ? "transparent" : fills[tone],
        border: ring ? "1px solid var(--fg-2)" : "none",
        ...style,
      }}
    />
  );
}
