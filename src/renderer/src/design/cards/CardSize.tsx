import type React from "react";
import { createContext, useContext } from "react";
import { IconButton } from "../core/IconButton";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "./cardSizeWords";

/**
 * The shown card's size, lent by the stage to the card it shows (design
 * skill `components/cards/ResponseCard.prompt.md`, "Maximize"): whether it
 * is maximized, and the one control that maximizes and restores it. A card
 * the stage prepares or keeps drawn while it leaves, and a card drawn off the
 * stage, gets none, so it draws no size control.
 */
export type CardSize = {
  maximized: boolean;
  /**
   * Maximizes or restores the card. `byKey` (Escape, a command) also puts
   * the keyboard's focus on the size control, ringed; a click leaves it on
   * the control it pressed.
   */
  toggle: (byKey?: boolean) => void;
  /** The key hint of the command that does the same (`cards.maximize`). */
  keys?: string | undefined;
  "aria-keyshortcuts"?: string | undefined;
};

export const CardSizeContext = createContext<CardSize | null>(null);

const icon = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Lucide maximize-2: arrows pointing out to the corners. */
const OUTWARD = (
  <svg {...icon} aria-hidden="true">
    <path d="M15 3h6v6" />
    <path d="m21 3-7 7" />
    <path d="m3 21 7-7" />
    <path d="M9 21H3v-6" />
  </svg>
);

/** Lucide minimize-2: arrows pointing back in. */
const INWARD = (
  <svg {...icon} aria-hidden="true">
    <path d="m14 10 7-7" />
    <path d="M20 10h-6V4" />
    <path d="m3 21 7-7" />
    <path d="M4 14h6v6" />
  </svg>
);

/** Maximize card, or Restore card while it is maximized; nothing where the stage lends no size. */
export function CardSizeToggle() {
  const size = useContext(CardSizeContext);
  if (!size) return null;
  return (
    <IconButton
      data-card-size-toggle={size.maximized ? "restore" : "maximize"}
      label={size.maximized ? RESTORE_LABEL : MAXIMIZE_LABEL}
      keys={size.keys}
      aria-keyshortcuts={size["aria-keyshortcuts"]}
      onClick={() => size.toggle()}
    >
      {size.maximized ? INWARD : OUTWARD}
    </IconButton>
  );
}

/**
 * A card's top-right corner: the size control, then the card's own Close or
 * Hide, which keep their meaning. Every card chrome puts its close in one.
 */
export function CardCorner({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span
      data-card-corner=""
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        flexShrink: 0,
        ...style,
      }}
    >
      <CardSizeToggle />
      {children}
    </span>
  );
}
