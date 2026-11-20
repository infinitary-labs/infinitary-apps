import { z } from "zod";

/** Display-only obligations, never executable instructions or permission to run them. */
export const requiredActionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  sharedId: z.string().min(1).max(64).optional(),
  target: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  consequence: z.string().min(1).max(500),
  instructions: z.array(z.string().min(1).max(2000)).min(1).max(20),
  criterion: z.string().min(1).max(1000),
  prerequisites: z.array(z.string().min(1).max(64)).max(50),
  completion: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual"), label: z.string().min(1).max(64) }),
    z.object({
      kind: z.literal("device-version"),
      deviceId: z.string().min(1).max(64),
      minVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    }),
  ]),
});
export const requiredActionsSchema = z.array(requiredActionSchema).max(20);
export type RequiredAction = z.infer<typeof requiredActionSchema>;

/** The words a correction may replace; target, ids, completion and prerequisites stay. */
export const REQUIRED_ACTION_TEXT_FIELDS = [
  "title",
  "consequence",
  "instructions",
  "criterion",
] as const;
export type RequiredActionTextField = (typeof REQUIRED_ACTION_TEXT_FIELDS)[number];
export const requiredActionTextSchema = requiredActionSchema
  .pick({ title: true, consequence: true, instructions: true, criterion: true })
  .partial();
export type RequiredActionText = z.infer<typeof requiredActionTextSchema>;

/**
 * One correction of a required action's words (docs/required-actions.md,
 * "Correcting the words"): who made it, when, why, the generation it
 * produced and the words it replaced. The original filing - its source
 * task, offer and version - stays on the requirement beside it.
 */
export const requiredActionCorrectionSchema = z.object({
  operationId: z.string().min(1).max(128),
  actor: z.enum(["crewmate", "firstmate"]),
  /** The contributing crewmate's task; absent for the first mate. */
  taskId: z.string().optional(),
  /** The host's words for who made it, as every view shows them. */
  label: z.string().min(1).max(160),
  at: z.number(),
  reason: z.string().min(1).max(500),
  generation: z.number().int().positive(),
  previous: requiredActionTextSchema,
});
export type RequiredActionCorrection = z.infer<typeof requiredActionCorrectionSchema>;

/**
 * A correction as a writer asks for it: the action (its task or card), the
 * requirement by its source task and action id, the generation read, the
 * new words, why, an operation identity, and the declaration that it is
 * still the same intended action.
 */
export const requiredActionRevisionInputSchema = z.object({
  action: z.string().min(1).max(128),
  source: z.string().min(1).max(64),
  actionId: z.string().min(1).max(64),
  expectedGeneration: z.number().int().positive(),
  patch: requiredActionTextSchema,
  reason: z.string().min(1).max(500),
  operationId: z.string().min(1).max(128),
  sameAction: z.boolean(),
});
export type RequiredActionRevisionInput = z.infer<typeof requiredActionRevisionInputSchema>;

export const captainActionSchema = z.object({
  requirements: z.array(
    z.object({
      source: z.string(),
      offer: z.string(),
      head: z.string().optional(),
      action: requiredActionSchema,
      /** Corrections of this requirement's words, oldest first. */
      corrections: z.array(requiredActionCorrectionSchema).optional(),
    }),
  ),
  generation: z.number().int().positive(),
  state: z.enum(["blocked", "ready", "deferred", "confirmed", "checked", "cancelled"]),
  cardId: z.string(),
  presentedGeneration: z.number().int().nonnegative(),
  activatedAt: z.number(),
  completedAt: z.number().optional(),
  cancelledReason: z.string().optional(),
});
export type CaptainAction = z.infer<typeof captainActionSchema>;
export type RequiredActionOffer = {
  cardId: string;
  offerId: string;
  head?: string;
  actions: RequiredAction[];
};

export function captainActionResult(action: CaptainAction): string {
  return action.state === "confirmed"
    ? "Confirmed by you"
    : action.state === "checked"
      ? "Checked by your first mate"
      : action.state === "cancelled"
        ? "Cancelled"
        : "Waiting on you";
}

export const requiredActionStatusSchema = z.object({
  cardId: z.string(),
  state: z.enum(["blocked", "ready", "deferred", "confirmed", "checked", "cancelled"]),
  result: z.string(),
});
export type RequiredActionStatus = z.infer<typeof requiredActionStatusSchema>;
