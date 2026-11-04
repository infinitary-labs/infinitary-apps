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
