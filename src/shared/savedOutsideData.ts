import { z } from "zod";

/**
 * What the app keeps of the words from outside its integrations hand an
 * agent, and for how long (INF-952; docs/task-retention.md, "Words from
 * outside"). A kind whose words are fenced (`@shared/outsideData`) declares
 * how many days they stay in saved conversations and what to call them; a
 * pass then puts a short note where they were, and the captain can do the
 * same for everything at once from Settings → General.
 */

/** One kind of fenced words the app keeps for a while: its fence label, its days and its name. */
export const keptOutsideDataSchema = z.strictObject({
  label: z.string().min(1).max(48),
  days: z.number().int().positive(),
  /** What a person calls them: "Gmail and Calendar content". */
  what: z.string().min(1).max(80),
});
export type KeptOutsideData = z.infer<typeof keptOutsideDataSchema>;

/** What one delete did: the conversations it changed, and those still working that follow. */
export const outsideDataDeletedSchema = z.strictObject({
  conversations: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});
export type OutsideDataDeleted = z.infer<typeof outsideDataDeletedSchema>;

/** What stands in a saved conversation where the words were. */
export function outsideDataDeletedNote(what: string): string {
  return `[${what} deleted]`;
}

/** A kept kind as a person reads of it: its days and its name. */
type KeptWords = Omit<KeptOutsideData, "label">;

/** Every kept kind's name, as one phrase. */
function whatOf(kept: readonly KeptWords[]): string {
  return kept.map((entry) => entry.what).join(" and ");
}

/** Settings → General's row (`delete-outside-data`). */
export const SAVED_OUTSIDE_DATA_WORDS = {
  title: (kept: readonly KeptWords[]) => `Delete ${whatOf(kept)}`,
  description: (kept: readonly KeptWords[]) => {
    const days = [...new Set(kept.map((entry) => entry.days))].join(" or ");
    return `Replaces the ${whatOf(kept)} your first mate and crew read with a note, in every saved conversation on this computer. It also goes on its own ${days} days after it was read.`;
  },
  delete: "Delete",
  confirm: "Confirm delete",
  pending: "Deleting...",
  done: ({ conversations, waiting }: OutsideDataDeleted) => {
    const changed =
      conversations === 0
        ? "Nothing left to delete."
        : `Deleted from ${conversations === 1 ? "1 conversation" : `${conversations} conversations`}.`;
    if (waiting === 0) return changed;
    return `${changed} ${waiting === 1 ? "1 more is" : `${waiting} more are`} deleted once ${waiting === 1 ? "its work pauses" : "their work pauses"}.`;
  },
} as const;
