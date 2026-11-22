/**
 * The words that name guidance still waiting for a task's crewmate
 * (INF-4072, finding 4), shared by a refused close and the finished-open
 * wake. Pure, so the wake words can import it; the reads and the drop are
 * `waitingGuidance.ts`'s.
 */

import { formatDurationShort } from "@shared/quotaSignals";

/** One message waiting for a crewmate, as a refusal or a wake names it. */
export type WaitingMessage = {
  /** The inbox row's id, which `drop_waiting` takes. */
  id: number;
  /** How long ago it was queued. */
  ageMs: number;
  /**
   * Where it stands: handed to a turn that never finished with it, tried
   * and not taken, or not delivered yet.
   */
  state: "handed" | "tried" | "queued";
  /** Delivery attempts spent on it. */
  attempts: number;
  /** Its words as the crewmate would read them, on one line and shortened. */
  excerpt: string;
};

function messageWords(message: WaitingMessage): string {
  const state =
    message.state === "handed"
      ? "handed to a turn that never finished with it"
      : message.state === "tried"
        ? `not taken after ${message.attempts} ${message.attempts === 1 ? "try" : "tries"}`
        : "not delivered yet";
  return `message ${message.id}, queued ${formatDurationShort(message.ageMs)} ago and ${state}: "${message.excerpt}"`;
}

/**
 * The waiting messages named, and the way to drop them: what a refused
 * close and the finished-open wake both say.
 */
export function waitingWords(messages: readonly WaitingMessage[]): string {
  if (messages.length === 0) return "";
  const ids = messages.map((message) => message.id).join(", ");
  const them = messages.length === 1 ? "it" : "them";
  // The quoted words come last, so no stop follows their own.
  return `If its crewmate no longer needs ${them}, close with settle_task done and drop_waiting [${ids}], which drops ${them} as the close goes through. Waiting: ${messages.map(messageWords).join("; ")}`;
}
