import { decisionStateSchema } from "@shared/decisions";
import { z } from "zod";

export const correctionSourceSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(["composer", "card", "crewmate-tab"]),
  at: z.number(),
  taskId: z.string().optional(),
  cardId: z.string().optional(),
  observationId: z.string().optional(),
  askId: z.string().optional(),
  inboxId: z.number().int().optional(),
});
export type CorrectionSource = z.infer<typeof correctionSourceSchema>;
export const correctionOfferSchema = z.object({
  cardId: z.string(),
  cardOfferId: z.string().optional(),
  directionId: z.string(),
  projectId: z.string(),
  text: z.string(),
  keepActionId: z.string(),
  declineActionId: z.string(),
  expectedRevision: z.number().int().optional(),
  savedRevision: z.number().int().optional(),
});
export type CorrectionOffer = z.infer<typeof correctionOfferSchema>;
export const correctionInputSchema = z.object({
  kind: z.literal("correction-input"),
  source: correctionSourceSchema,
  state: decisionStateSchema,
  offer: correctionOfferSchema.optional(),
  previousOffers: z.array(correctionOfferSchema).optional(),
  choiceOfferId: z.string().optional(),
  explicitSourceId: z.string().optional(),
});
export type CorrectionInput = z.infer<typeof correctionInputSchema>;
export type CorrectionReview = {
  kind: "correction-review";
  inputId: number;
  source: CorrectionSource;
  saved?: true;
  selected?: true;
  /** The one more ask after a turn on the first ended without the save landing. */
  retry?: true;
};
