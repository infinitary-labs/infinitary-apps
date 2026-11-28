import { z } from "zod";
import { TURN_IMAGES_MAX, turnImageSchema } from "./cards";
import { PASTE_FILES_MAX } from "./composer";

/**
 * The main message as the window lends it to the card overlay and the
 * overlay hands it back (docs/card-overlay.md, "The message box"): one draft
 * in two places, held in memory only and never saved. `lastSent` is what Up
 * brings back, and `replacing` the newest message the draft would replace.
 */

const pastedTextSchema = z.strictObject({
  id: z.string().min(1).max(64),
  text: z.string(),
  name: z.string().max(256).optional(),
});

const attachmentSchema = turnImageSchema.extend({
  id: z.string().min(1).max(64),
  /** The picture as a data address, so another page draws it with no file of its own. */
  preview: z.string().min(1),
});

const sentSchema = z.strictObject({
  text: z.string(),
  pastes: z.array(pastedTextSchema).max(PASTE_FILES_MAX),
  attachments: z.array(attachmentSchema).max(TURN_IMAGES_MAX),
  askId: z.string().min(1).max(256).optional(),
});

export const mainDraftSchema = z.strictObject({
  text: z.string(),
  pastes: z.array(pastedTextSchema).max(PASTE_FILES_MAX),
  attachments: z.array(attachmentSchema).max(TURN_IMAGES_MAX),
  lastSent: sentSchema.nullable(),
  replacing: z.string().min(1).max(256).nullable(),
});
export type MainDraft = z.infer<typeof mainDraftSchema>;

/**
 * A draft lent for one opening of the overlay: `ask` names the lending, so
 * the hand-back reaches the window that lent it and only while that window's
 * own box is as it lent it.
 */
export const lentDraftSchema = z.strictObject({
  ask: z.number().int().positive(),
  draft: mainDraftSchema,
});
export type LentDraft = z.infer<typeof lentDraftSchema>;

/** The window was asked for its draft (`ask`): it answers with `inf:composer:lent`. */
export const lendAskSchema = z.strictObject({ ask: z.number().int().positive() });
