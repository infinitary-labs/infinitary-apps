import type { CardMessageWho } from "@shared/cards";

/** Who wrote a thread's message, in the words the thread shows (`CardThread.tsx`, and the phone's card). */
export const THREAD_WHO_LABELS: Readonly<Record<CardMessageWho, string>> = {
  captain: "you",
  crewmate: "crew",
  firstmate: "mate",
  host: "app",
};

/** The thread's live tail while the author's turn runs. */
export const THREAD_WORKING = "working";

/** The folded line over the settings a reply carried. */
export function settingsCountWords(count: number): string {
  return `settings · ${count} ${count === 1 ? "value" : "values"}`;
}

/** How many messages a thread holds: the collapsed thread's latest line, and the phone's. */
export function messageCountWords(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

/** The name the collapsed thread's latest line reads to assistive technology: its count words, or that the author is working. */
export function threadCueLabel(count: string, working: boolean): string {
  return `Show thread, ${working ? "author working" : count}`;
}

/** The replies that came while the card showed its face: the phone's latest line (INF-1919). */
export function newCountWords(count: number): string {
  return `${count} new`;
}

/** The thread with its count: the in-place rung's segment, and the head of the phone card's back. */
export function threadCountWords(count: number): string {
  return `thread · ${count}`;
}

/** The way back from the thread to the card's face: the in-place rung's segment, and the phone card's back. */
export const THREAD_CARD = "card";

/** The card changed while its thread showed: what the mark beside the phone card back's Card says (INF-2565). */
export const THREAD_CARD_UPDATED = "updated";

/**
 * Who really wrote a thread line that is not the card's own answerer's, and
 * whether it is a clarification on a closed card (docs/card-threads.md,
 * "Shared cards"): the same words on the Mac and the phone. `label` is the
 * host's own name for the writer, such as "the crewmate on INF-12".
 */
export function contributorWords(line: {
  host: boolean;
  label?: string;
  clarification?: boolean;
}): string {
  const by = line.label ? `${line.host ? "Revised" : "Written"} by ${line.label}` : "";
  if (!line.clarification) return by;
  return by ? `${by}, after the card closed` : "Written after the card closed";
}
