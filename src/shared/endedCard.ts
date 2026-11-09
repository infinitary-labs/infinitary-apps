import { z } from "zod";
import type { CardCornerWords, NoteDone } from "./cardLeave.ts";

/**
 * A card its author ended while the captain had it in front of them
 * (INF-3071): the record ends it at once, as any withdrawal, but the stack
 * keeps drawing it, marked ended, until the captain closes it. Snapshot and
 * saved-row facts, never an author's: `CardService` is the one writer.
 */
export const cardEndedSchema = z.object({
  /** Who ended it: the card's crewmate or the first mate. */
  by: z.enum(["crewmate", "firstmate"]),
  /** The author's reason, written for the captain; absent when it gave none. */
  reason: z.string().optional(),
  at: z.number(),
  /** The thread's app line, whole, so every view draws the same words. */
  line: z.string(),
});
export type CardEnded = z.infer<typeof cardEndedSchema>;

/** The chip an ended card wears in place of its kind. */
export const ENDED_CHIP_LABEL = "Ended";
/** The ended card's one button, and its thread line's. */
export const ENDED_CLOSE_LABEL = "Close";
export const ENDED_CLOSE_CARD_LABEL = "Close card";
const ENDED_CLOSE_REST = `${ENDED_CLOSE_LABEL} · nothing on it waits on you`;

/** Who ended it, as the line names them. */
function enderWords(by: CardEnded["by"]): string {
  return by === "firstmate" ? "Your first mate" : "Its crewmate";
}

/**
 * The thread's app line: who ended the card, the reason it gave, and that
 * nothing on it waits on the captain.
 */
export function endedLineWords(by: CardEnded["by"], reason?: string): string {
  const why = reason?.trim().replace(/[.\s]+$/, "");
  return `${enderWords(by)} ended this card${why ? `: ${why}` : ""}. Nothing on it waits on you.`;
}

/**
 * The ended card's one button, sent as a note's (`Card.noteDone`) so every
 * view, a phone from before ended cards included, draws Close where the
 * choices were and presses it through the note's own request.
 */
export const ENDED_CLOSE: NoteDone = {
  label: ENDED_CLOSE_LABEL,
  restWords: ENDED_CLOSE_REST,
  closesTask: false,
};

/** The corner minus closes an ended card too: nothing on it can wait. */
export const ENDED_CORNER: CardCornerWords = {
  icon: "minus",
  label: ENDED_CLOSE_LABEL,
  restWords: ENDED_CLOSE_REST,
  operation: "read",
};
