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

/**
 * What one delete did: the conversations it changed, those still working
 * that follow, and those on a computer that runs work that follow once it
 * is back in reach, or once Infinitary there is updated (`outside-data-there.md`).
 */
export const outsideDataDeletedSchema = z.strictObject({
  conversations: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  elsewhere: z
    .array(
      z.strictObject({
        /** The computer's name, as Settings → Devices shows it. */
        computer: z.string().min(1).max(200),
        conversations: z.number().int().positive(),
        until: z.enum(["reach", "update"]),
      }),
    )
    .max(256)
    .optional(),
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

/** How many conversations, in words. */
function conversationCount(count: number): string {
  return count === 1 ? "1 conversation" : `${count} conversations`;
}

/** Settings → General's row (`delete-outside-data`). */
export const SAVED_OUTSIDE_DATA_WORDS = {
  title: (kept: readonly KeptWords[]) => `Delete ${whatOf(kept)}`,
  description: (kept: readonly KeptWords[]) => {
    const days = [...new Set(kept.map((entry) => entry.days))].join(" or ");
    return `Replaces the ${whatOf(kept)} your first mate and crew read with a note, in every saved conversation, on this computer and on the computers that run your work. It also goes on its own ${days} days after it was read.`;
  },
  delete: "Delete",
  confirm: "Confirm delete",
  pending: "Deleting...",
  done: ({ conversations, waiting, elsewhere = [] }: OutsideDataDeleted) => {
    const later = [
      ...(waiting > 0
        ? [
            {
              count: waiting,
              where: "",
              once: waiting === 1 ? "its work pauses" : "their work pauses",
            },
          ]
        : []),
      ...elsewhere.map((entry) => ({
        count: entry.conversations,
        where: ` on ${entry.computer}`,
        once: entry.until === "reach" ? "it is back in reach" : "Infinitary there is updated",
      })),
    ];
    if (conversations === 0 && later.length === 0) return "Nothing left to delete.";
    const sentences =
      conversations > 0 ? [`Deleted from ${conversationCount(conversations)}.`] : [];
    for (const entry of later) {
      const what = sentences.length > 0 ? `${entry.count} more` : conversationCount(entry.count);
      sentences.push(
        `${what}${entry.where} ${entry.count === 1 ? "is" : "are"} deleted once ${entry.once}.`,
      );
    }
    return sentences.join(" ");
  },
} as const;
