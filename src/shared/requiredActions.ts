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

export const captainActionSchema = z.object({
  requirements: z.array(
    z.object({
      source: z.string(),
      offer: z.string(),
      head: z.string().optional(),
      action: requiredActionSchema,
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
