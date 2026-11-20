import * as m from "@shared/i18n/messages.generated";
import type { AnyCommandId } from "@shared/keyboard";
import type React from "react";
import { createContext, useContext } from "react";
import { IconButton } from "../core/IconButton";

/**
 * Finding words in the shown card, lent by the stage to the card it shows
 * (design skill `components/cards/ResponseCard.prompt.md`, "Find in this
 * card"): whether the find field is open, the magnifying glass's press, and
 * the field the head draws in place of its meta line while it is open. A
 * card the stage prepares or keeps drawn while it leaves, a card drawn off
 * the stage, a panel's card and a task's browser get none, so they draw no
 * magnifying glass.
 */
export type CardFind = {
  open: boolean;
  /** The magnifying glass's press: opens the field with the caret in it. */
  start: () => void;
  /** The find field, drawn in the head in place of the meta line, task key and model chip. */
  field: React.ReactNode;
  /** The key hint of the command that does the same (`cards.find`). */
  keys?: string | undefined;
  "aria-keyshortcuts"?: string | undefined;
  "data-key-command"?: AnyCommandId | undefined;
};

export const CardFindContext = createContext<CardFind | null>(null);

/** The find field while it is open on this card, for the head to draw in place of its meta line. */
export function useCardFindField(): React.ReactNode | null {
  const find = useContext(CardFindContext);
  return find?.open ? find.field : null;
}

/** Lucide search: the app's own search icon. */
export const FIND_ICON = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

/** The magnifying glass just before Maximize; nothing while the field is open or where the stage lends no find. */
export function CardFindButton() {
  const find = useContext(CardFindContext);
  if (!find || find.open) return null;
  return (
    <IconButton
      data-card-find-button=""
      label={m.uiCardFind()}
      keys={find.keys}
      aria-keyshortcuts={find["aria-keyshortcuts"]}
      data-key-command={find["data-key-command"]}
      onClick={() => find.start()}
    >
      {FIND_ICON}
    </IconButton>
  );
}
