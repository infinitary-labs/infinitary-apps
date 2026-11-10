import { z } from "zod";

/** A note uses the same part identity as revision navigation, never a selector. */
export const cardNoteSchema = z.object({
  start: z.number().int().nonnegative(),
  key: z.string().max(65_536),
  endKey: z.string().max(65_536).optional(),
  kind: z.string().min(1).max(32),
  excerpt: z.string().max(240),
  span: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      endPart: z.number().int().nonnegative().optional(),
    })
    .refine((span) => span.endPart !== undefined || span.end > span.start)
    .optional(),
  // Same physical field size as the card reply (CARD_REPLY_MAX_CHARS).
  comment: z.string().max(4_000),
  line: z.number().int().positive(),
});
export const cardNotesSchema = z.array(cardNoteSchema);
export type CardNote = z.infer<typeof cardNoteSchema>;
export const POINT_AT = "Point at";
export const POINTED_AT = "Pointed at";
export const STALE_NOTE = "This part is no longer in the card";
export const UNAVAILABLE_NOTE = "This part cannot be shown in this view";
export const EDIT_UNAVAILABLE = "Editing is unavailable in this view";
export const EMPTY_NOTE = "No comment";

export function pointedAtLines(notes: readonly CardNote[]): string[] {
  if (!notes.length) return [];
  return [
    "Pointed at:",
    ...notes.map(
      (note) =>
        `- ${note.kind} ${JSON.stringify(note.excerpt)}${note.span ? ` (characters ${note.span.start}–${note.span.end}${note.span.endPart !== undefined ? `, ending in the part at body offset ${note.span.endPart}` : ""})` : ""}, body line ${note.line}: ${note.comment || EMPTY_NOTE}`,
    ),
  ];
}

export const ANNOTATE = "Annotate";
export const QUEUE_NOTE = "Queue";
export const NOTE_COMMENT_LABEL = "Comment on this part";
export const NOTE_CANCEL = "Cancel";
export const NOTE_EDIT = "Edit";
export const NOTE_REMOVE = "Remove";
export const NOT_SENT = "Not sent";
export function queuedNotesWords(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"} not sent`;
}

/** Reader-facing fallback for a view that cannot draw structured notes. */
export function noteLabel(note: Pick<CardNote, "kind" | "excerpt">): string {
  return `${POINTED_AT} ${note.kind}: “${note.excerpt}”`;
}
export function noteText(note: CardNote): string {
  return `${noteLabel(note)}\n${note.comment || EMPTY_NOTE}`;
}
