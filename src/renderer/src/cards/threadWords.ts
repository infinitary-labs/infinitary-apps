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
