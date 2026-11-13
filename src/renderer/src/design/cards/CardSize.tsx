import { type CardCornerWords, cardCornerOf } from "@shared/cardLeave";
import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { fixedKeys } from "../core/fixedKeys";
import { IconButton } from "../core/IconButton";

/**
 * The shown card's size, lent by the stage to the card it shows (design
 * skill `components/cards/ResponseCard.prompt.md`, "Maximize"): whether it
 * is maximized, and the one control that maximizes and restores it. A card
 * the stage prepares or keeps drawn while it leaves, and a card drawn off the
 * stage, gets none, so it draws no size control.
 */
export type CardSize = {
  maximized: boolean;
  corner?: CardCornerWords;
  minimize?: {
    run: () => void;
    keys?: string | undefined;
    "aria-keyshortcuts"?: string | undefined;
  };
  /**
   * Put every card aside (INF-4002): what a click on the minus does with ⌥
   * (Alt) held, as ⌥ on a Mac window's own minimize does to every window.
   */
  minimizeAll?: {
    run: () => void;
    keys?: string | undefined;
    "aria-keyshortcuts"?: string | undefined;
  };
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
      label={size.maximized ? m.uiCardRestore() : m.uiCardMaximize()}
      // Esc also restores a maximized card (app/App.tsx), so Restore card
      // names it when Maximize or restore card has no key of its own.
      keys={size.maximized ? (size.keys ?? fixedKeys("Escape").keys) : size.keys}
      aria-keyshortcuts={
        size.maximized
          ? [size["aria-keyshortcuts"], fixedKeys("Escape")["aria-keyshortcuts"]]
              .filter(Boolean)
              .join(" ")
          : size["aria-keyshortcuts"]
      }
      onClick={() => size.toggle()}
    >
      {size.maximized ? INWARD : OUTWARD}
    </IconButton>
  );
}

/**
 * Whether ⌥ (Alt) is held now, read from the window's keys and from the
 * pointer's own events, which carry it even while a card's frame has the
 * keyboard; a window that loses focus lets it go.
 */
function useOptionHeld(): [boolean, (event: { altKey: boolean }) => void] {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const read = (event: KeyboardEvent) => setHeld(event.altKey);
    const letGo = () => setHeld(false);
    window.addEventListener("keydown", read, true);
    window.addEventListener("keyup", read, true);
    window.addEventListener("blur", letGo);
    return () => {
      window.removeEventListener("keydown", read, true);
      window.removeEventListener("keyup", read, true);
      window.removeEventListener("blur", letGo);
    };
  }, []);
  return [held, (event) => setHeld(event.altKey)];
}

/**
 * The only card corner: maximize, then a minus that never ends work. With
 * ⌥ held the minus puts every card aside, and its label says so (INF-4002).
 */
export function CardCorner({
  buttonRef,
  style,
}: {
  buttonRef?: React.Ref<HTMLButtonElement> | undefined;
  style?: React.CSSProperties;
}) {
  const size = useContext(CardSizeContext);
  const corner = size?.corner ?? cardCornerOf("window-panel");
  const [optionHeld, readOption] = useOptionHeld();
  const all = optionHeld ? size?.minimizeAll : undefined;
  const leave = all ?? size?.minimize;
  return (
    <span
      data-card-corner=""
      onPointerEnter={readOption}
      onPointerMove={readOption}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        flexShrink: 0,
        ...style,
      }}
    >
      <CardSizeToggle />
      <IconButton
        ref={buttonRef}
        data-card-leave={all ? "all" : ""}
        label={all ? m.uiCardPutEveryCardAside() : corner.label}
        restWords={all ? undefined : corner.restWords}
        tone={all ? "accent" : "neutral"}
        keys={leave?.keys}
        aria-keyshortcuts={leave?.["aria-keyshortcuts"]}
        onClick={(event) => {
          // The click's own ⌥ decides, whatever the label last read.
          if (event.altKey && size?.minimizeAll) size.minimizeAll.run();
          else size?.minimize?.run();
        }}
      >
        <svg {...icon} aria-hidden="true">
          <path d="M5 12h14" />
        </svg>
      </IconButton>
    </span>
  );
}
