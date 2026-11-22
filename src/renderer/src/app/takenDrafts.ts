import type { CardNote } from "@shared/cardNotes";

/**
 * The words and notes this window took from another window's card draft,
 * by card, exactly as it took them (./cardDrafts.ts). They were typed in
 * that other window and the first mate's computer keeps them, so they never
 * hold this app's restart (./unsentWords.ts); once the captain changes them
 * here, the window holds its own words again.
 */
const taken = new Map<string, { words?: string; notes?: readonly CardNote[] }>();

/** This window takes another window's words or notes for a card. */
export function markTaken(cardId: string, parts: { words?: string; notes?: readonly CardNote[] }) {
  taken.set(cardId, { ...taken.get(cardId), ...parts });
}

/** The card left, or opened anew: nothing taken for it stands. */
export function forgetTaken(cardId: string): void {
  taken.delete(cardId);
}

/** Whether a card's words here are exactly the ones taken from another window. */
export function wordsTaken(cardId: string, words: string): boolean {
  const held = taken.get(cardId);
  return held?.words !== undefined && held.words === words;
}

/** Whether a card's notes here are exactly the ones taken from another window. */
export function notesTaken(cardId: string, notes: readonly CardNote[]): boolean {
  return taken.get(cardId)?.notes === notes;
}
