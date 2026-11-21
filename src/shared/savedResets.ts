import { z } from "zod";

/**
 * Using a saved Codex reset (docs/codex-client.md, docs/quota.md "Saved
 * resets"): Infinitary asks the Codex CLI the person installed, through its
 * app-server, to use one of the account's saved resets. These are the
 * shapes the window, a computer that runs work and the first mate share.
 */

/**
 * The oldest Codex CLI that can use a chosen saved reset: 0.141 added the
 * request, and 0.143 each reset's id and expiry, which pick the one that
 * expires first.
 */
export const CODEX_SAVED_RESET_FLOOR = "0.143.0";

/**
 * What using a saved reset came to, when Codex answered clearly:
 * - `used` the reset refilled the allowance (or that same attempt already
 *   had), with how many the account holds after it, when Codex said;
 * - `nothing-to-reset` no allowance it covers was spent, so nothing was used;
 * - `none-left` the account holds no saved reset that applies.
 * Anything unclear is an error, never one of these.
 */
export const savedResetResultSchema = z.object({
  outcome: z.enum(["used", "nothing-to-reset", "none-left"]),
  left: z.number().int().nonnegative().optional(),
});
export type SavedResetResult = z.infer<typeof savedResetResultSchema>;

/**
 * How a use is asked for: the computer that runs work whose own account it
 * is, and whether Codex may start its sign-in when it has none for the
 * account. A use without `signIn` (the first mate's, or a card's while
 * Codex is signed in) is refused with words saying where to sign in.
 */
export const useSavedResetOptionsSchema = z.strictObject({
  deviceId: z.string().min(1).max(64).optional(),
  signIn: z.boolean().optional(),
});
export type UseSavedResetOptions = z.infer<typeof useSavedResetOptionsSchema>;
