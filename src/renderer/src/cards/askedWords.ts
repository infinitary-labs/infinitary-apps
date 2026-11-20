import type { CardAsked } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { clock } from "./revisedLine";

/**
 * The line under a card's title (INF-1610, INF-2326; design skill
 * ResponseCard, "The You asked line"), in a plain module a spec can load:
 * the label saying where the card's work came from and when, and the words
 * under it.
 */

/** Each kind's label before its time. */
export const ASKED_LABELS = {
  get asked() {
    return m.cardAskedYouAsked();
  },
  get said() {
    return m.cardAskedYouSaid();
  },
  get chose() {
    return m.cardAskedYouChose();
  },
  get automation() {
    return m.cardAskedAutomation();
  },
};

/** The label's tail when the source sits on another task: "· through 3 tasks". */
export function throughWords(through: number | undefined): string {
  if (!through) return "";
  return ` ${m.cardAskedThrough({ count: through })}`;
}

/**
 * The label: "You asked · 9:10 AM", "Run by an automation · 3:00 AM", a
 * click's naming the card it was on (INF-2744): "You chose on “Ship the
 * fix” · 9:10 AM", with
 * "· through N tasks" when the source is on another task, or "From INF-2081"
 * for the nearest task the work came from.
 */
export function askedLabel(
  asked: Pick<CardAsked, "at" | "kind" | "key" | "through" | "card">,
  now: number = Date.now(),
): string {
  const kind = asked.kind ?? "asked";
  if (kind === "from") return m.cardAskedFrom({ key: asked.key ?? "" }).trim();
  const label =
    kind === "chose" && asked.card ? m.cardAskedChoseOn({ card: asked.card }) : ASKED_LABELS[kind];
  return `${label} · ${clock(asked.at, now)}${throughWords(asked.through)}`;
}

/**
 * Whether the words are the captain's own and sit in the grey bubble: a
 * message, or a click with its button's words. An automation's name and a
 * task's title are not their words, so they sit without it.
 */
export function askedInBubble(asked: Pick<CardAsked, "kind">): boolean {
  return asked.kind !== "automation" && asked.kind !== "from";
}

/** The words the line shows: a click's button words, then what the captain wrote with it. */
export function askedText(asked: Pick<CardAsked, "kind" | "text" | "choice">): string {
  if (asked.kind !== "chose") return asked.text;
  const written = asked.text.trim();
  return written ? `${asked.choice ?? ""} · ${written}` : (asked.choice ?? "");
}

/**
 * Names of the bubble's expand/fold actions; no separate link is drawn.
 * These constants hold the source language's words as the module loads,
 * for the specs; the window words them when shown (`m.cardAskedShowAll`).
 */
export const ASKED_SHOW_ALL = m.cardAskedShowAll();
export const ASKED_SHOW_LESS = m.cardAskedShowLess();

/** A message that was only pictures says so, with no quotation marks; the source words, as `ASKED_SHOW_ALL`. */
export const ASKED_PICTURE_WORDS = m.cardAskedPicture();

/**
 * The captain's words in the bubble, without added quotation marks, or
 * "A picture" for a message with no words. Folded, the lines of a long
 * message run together so the start of every paragraph has room.
 */
export function askedWords(text: string, open: boolean): string {
  const words = open ? text.trim() : text.replace(/\s+/g, " ").trim();
  return words || m.cardAskedPicture();
}
