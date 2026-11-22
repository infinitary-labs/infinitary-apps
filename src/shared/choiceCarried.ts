import { z } from "zod";
import { cardNotesSchema } from "./cardNotes.ts";
import { cardAnswersSchema, TURN_IMAGES_MAX, turnImageSchema } from "./cards.ts";
import { pastedFilesSchema } from "./channels/common.ts";
import { formatList } from "./i18n/format.ts";
import * as m from "./i18n/messages.generated.ts";

/**
 * What a footer click carries as `inf:cards:act`'s value, and a note's own
 * button as `inf:cards:note-done`'s: the answers, the card field's words among
 * them, in one envelope. With the `choice-attachments` change it also carries
 * what else waits in the field - its queued notes, pasted files and pictures,
 * marked ones drawn at the press - so they go with the choice in one request
 * (`docs/card-authoring.md`, "The card's one field"). A frame click's value
 * stays the body's own.
 */
export const cardChromeValueSchema = z.strictObject({
  answers: cardAnswersSchema,
  notes: cardNotesSchema.optional(),
  files: pastedFilesSchema.optional(),
  images: z.array(turnImageSchema).max(TURN_IMAGES_MAX).optional(),
});
export type CardChromeValue = z.infer<typeof cardChromeValueSchema>;

/** What rides a choice besides its answers: present only when something does. */
export type ChoiceCarried = Pick<CardChromeValue, "notes" | "files" | "images">;

/** The name the home lists once a button's press may carry the field's notes, files and pictures. */
export const CHOICE_ATTACHMENTS = "choice-attachments";

/** Whether a home with these changes takes them, as a view reads its healthcheck. */
export function homeTakesChoiceAttachments(
  view: boolean,
  homeChanges: readonly string[] | null | undefined,
): boolean {
  return !view || (homeChanges?.includes(CHOICE_ATTACHMENTS) ?? false);
}

/**
 * The line a card's footer shows while something waits in its field: what
 * goes with whichever button is pressed, by kind and count, or null when
 * nothing waits.
 */
export function carriedWithChoiceWords(waiting: {
  pictures: number;
  files: number;
  notes: number;
}): string | null {
  const items = [
    ...(waiting.pictures > 0 ? [m.cardCarriedPictures({ count: waiting.pictures })] : []),
    ...(waiting.files > 0 ? [m.cardFilesAll({ count: waiting.files })] : []),
    ...(waiting.notes > 0 ? [m.cardCarriedNotes({ count: waiting.notes })] : []),
  ];
  const count = waiting.pictures + waiting.files + waiting.notes;
  return items.length > 0 ? m.cardCarriedWithChoice({ count, items: formatList(items) }) : null;
}
