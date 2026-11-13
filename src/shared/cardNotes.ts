import { z } from "zod";
import { inLanguage } from "./i18n/current.ts";
import { SOURCE_LANGUAGE } from "./i18n/languages.ts";
import * as m from "./i18n/messages.generated.ts";

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
export const POINT_AT = m.cardNotePointAt();
export const POINTED_AT = m.cardNotePointedAt();
export const STALE_NOTE = m.cardNoteStale();
export const UNAVAILABLE_NOTE = m.cardNoteUnavailable();
export const EDIT_UNAVAILABLE = m.cardNoteEditUnavailable();
export const EMPTY_NOTE = m.cardNoteEmpty();

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

export const ANNOTATE = m.cardNoteAnnotate();
export const QUEUE_NOTE = m.cardNoteQueue();
export const NOTE_COMMENT_LABEL = m.cardNoteCommentLabel();
export const NOTE_CANCEL = m.cardNoteCancel();
export const NOTE_EDIT = m.cardNoteEdit();
export const NOTE_REMOVE = m.cardNoteRemove();
export const NOT_SENT = m.cardNoteNotSent();
export const NOTE_PLACEHOLDER = m.cardNotePlaceholder();
export const NOTE_DISCARD_HINT = m.cardNoteDiscardHint();
/** The card's send button while notes wait (INF-3786): the notes and any typed words leave as one reply. */
export function sendNotesLabel(count: number): string {
  return m.cardNoteSend({ count });
}
export function queuedNotesWords(count: number): string {
  return m.cardNoteQueued({ count });
}

/** Reader-facing fallback for a view that cannot draw structured notes. */
export function noteLabel(note: Pick<CardNote, "kind" | "excerpt">): string {
  return m.cardNoteLabel({ kind: note.kind, excerpt: note.excerpt });
}
/** A note as the saved reply and the crew read it: always the source language (docs/i18n.md, "What stays English"). */
export function noteText(note: CardNote): string {
  return `${inLanguage(SOURCE_LANGUAGE, () => noteLabel(note))}\n${note.comment || EMPTY_NOTE}`;
}
