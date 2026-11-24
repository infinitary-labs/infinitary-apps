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

/**
 * What the row hears back: the app quits now and starts again on the welcome
 * screen, or the system's own confirmation was not given and nothing changed.
 */
export const resetAnswerSchema = z.strictObject({
  outcome: z.enum(["restarting", "kept"]),
});
export type ResetAnswer = z.infer<typeof resetAnswerSchema>;
