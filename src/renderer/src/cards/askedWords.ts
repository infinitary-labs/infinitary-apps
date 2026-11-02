import { clock } from "./revisedLine";

/**
 * The "You asked" line's words (INF-1610; design skill ResponseCard, "The
 * You asked line"), in a plain module a spec can load: the label with the
 * time the captain sent the message the card is about, and their words.
 */

/** The label before the captain's words: "You asked · 9:10 AM". */
export function askedLabel(at: number, now: number = Date.now()): string {
  return `You asked · ${clock(at, now)}`;
}

/** Names of the bubble's expand/fold actions; no separate link is drawn. */
export const ASKED_SHOW_ALL = "Show all";
export const ASKED_SHOW_LESS = "Show less";

/** A message that was only pictures says so, with no quotation marks. */
export const ASKED_PICTURE_WORDS = "A picture";

/**
 * The captain's words in the bubble, without added quotation marks, or
 * "A picture" for a message with no words. Folded, the lines of a long
 * message run together so the start of every paragraph has room.
 */
export function askedWords(text: string, open: boolean): string {
  const words = open ? text.trim() : text.replace(/\s+/g, " ").trim();
  return words || ASKED_PICTURE_WORDS;
}
