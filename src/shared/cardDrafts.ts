import { z } from "zod";
import { cardNotesSchema } from "./cardNotes";
import { CARD_MAX_ANSWERS, CARD_REPLY_MAX_CHARS } from "./cards";
import { frameAnswerSchema } from "./plugins/bridge";

/**
 * An open card's unsent draft, as the first mate's computer keeps it for
 * every window that shows the card (docs/card-authoring.md, "Unsent picks
 * follow you"): the picks in the card's body by question, the words in the
 * card's own field and the notes waiting to go with them. A draft lasts as
 * long as its card is open and is never read by an agent; nothing it holds
 * is sent until the captain presses a button or sends a reply.
 */

/** The contract change that adds drafts (`src/shared/contract-changes/card-drafts.md`). */
export const CARD_DRAFTS = "card-drafts";

const cardIdSchema = z.string().min(1).max(256);
/** The card's opening a draft belongs to (`Card.lifecycleId`): a card reopened under its id starts a new one. */
const lifecycleSchema = z.string().min(1).max(64);

/**
 * One card's draft. `revision` counts the changes the card's draft took,
 * from 1; a card with no draft reads at revision 0 with nothing in it.
 */
export const cardDraftSchema = z.strictObject({
  cardId: cardIdSchema,
  /** The card's opening, absent for a card written before openings were kept. */
  lifecycle: lifecycleSchema.optional(),
  revision: z.number().int().nonnegative(),
  /** The body's answers that a window changed, one per question name. */
  answers: z.array(frameAnswerSchema).max(CARD_MAX_ANSWERS),
  words: z.string().max(CARD_REPLY_MAX_CHARS),
  notes: cardNotesSchema,
});
export type CardDraft = z.infer<typeof cardDraftSchema>;

/** Every open card's draft that holds anything, as a window reads them at each welcome. */
export const cardDraftsSchema = z.array(cardDraftSchema);

/**
 * What a window changed in a card's draft since it last heard the draft at
 * `since`. Each part named takes its new value, unless another window
 * changed that same part after `since`: then the newer value stays.
 */
export const cardDraftChangeSchema = z.strictObject({
  since: z.number().int().nonnegative(),
  /** The card's opening the window changed; a change for an earlier opening is refused as closed. */
  lifecycle: lifecycleSchema.optional(),
  answers: z.array(frameAnswerSchema).max(CARD_MAX_ANSWERS).optional(),
  words: z.string().max(CARD_REPLY_MAX_CHARS).optional(),
  notes: cardNotesSchema.optional(),
});
export type CardDraftChange = z.infer<typeof cardDraftChangeSchema>;

/**
 * The parts of a change that another window's newer change kept the draft
 * from taking, named as the change named them: the questions by name, and
 * the words or the notes.
 */
export const cardDraftPassedSchema = z.strictObject({
  answers: z.array(frameAnswerSchema.shape.name).max(CARD_MAX_ANSWERS).optional(),
  words: z.literal(true).optional(),
  notes: z.literal(true).optional(),
});
export type CardDraftPassed = z.infer<typeof cardDraftPassedSchema>;

/**
 * The change's answer: the card's draft as it now stands, with the parts a
 * newer change kept it from taking (`passed`), or why nothing was kept - the
 * card is no longer open or opened anew, or its answers would pass what a
 * press may send (`CARD_ANSWERS_MAX_BYTES`).
 */
export const cardDraftChangedSchema = z.union([
  z.strictObject({ draft: cardDraftSchema, passed: cardDraftPassedSchema.optional() }),
  z.strictObject({ refused: z.enum(["closed", "too-large"]) }),
]);
export type CardDraftChanged = z.infer<typeof cardDraftChangedSchema>;

export function emptyDraft(cardId: string): CardDraft {
  return { cardId, revision: 0, answers: [], words: "", notes: [] };
}
