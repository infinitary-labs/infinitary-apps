import { z } from "zod";

/**
 * Reset Infinitary (docs/reset.md): the row in Settings → General that takes
 * this computer's Infinitary back to how it was just installed.
 */

/** What the row's question counts before the person answers it. */
export const resetScopeSchema = z.strictObject({
  /** Open tasks, whose crewmates stop and whose working copies go. */
  tasks: z.number().int().nonnegative(),
});
export type ResetScope = z.infer<typeof resetScopeSchema>;

/** What the first mate's own side undid before the wipe: how many steps it could not finish. */
export const resetPreparedSchema = z.strictObject({
  left: z.number().int().nonnegative(),
});
export type ResetPrepared = z.infer<typeof resetPreparedSchema>;

/** What the row hears back: the app quits now and starts again on the welcome screen. */
export const resetAnswerSchema = z.strictObject({
  outcome: z.literal("restarting"),
});
export type ResetAnswer = z.infer<typeof resetAnswerSchema>;
