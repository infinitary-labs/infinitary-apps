import { z } from "zod";

/**
 * What a first mate a command started asks of this computer's window
 * (docs/run.md, "The window opened beside it"): that first mate keeps the
 * settings, the records and the crew and has no desktop, so what only a
 * program in the person's own session can do - read or change what the
 * system starts at login, show the file picker over a window - it asks of
 * the window opened beside it, which answers from its own program.
 */
export const ownWindowAskSchema = z.discriminatedUnion("kind", [
  /** Reads Start at login, or changes it first when `set` is given. */
  z.strictObject({ kind: z.literal("start-at-login"), set: z.boolean().optional() }),
  /** The file picker, for a page of a task's browser the captain holds. */
  z.strictObject({ kind: z.literal("choose-files"), multiple: z.boolean() }),
]);
export type OwnWindowAsk = z.infer<typeof ownWindowAskSchema>;

export const ownWindowAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start-at-login"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("choose-files"), paths: z.array(z.string().min(1)) }),
  /** The window could not do it; `message` says why in plain words. */
  z.strictObject({ kind: z.literal("failed"), message: z.string().min(1).max(400) }),
]);
export type OwnWindowAnswer = z.infer<typeof ownWindowAnswerSchema>;

/** One ask on its way to the window (`inf:own-window:ask`); the answer names its id. */
export const ownWindowAskedSchema = z.strictObject({
  id: z.string().min(1).max(64),
  ask: ownWindowAskSchema,
});
export type OwnWindowAsked = z.infer<typeof ownWindowAskedSchema>;

/** Show in Dock as the first mate keeps it, for this computer's window to apply (`inf:presence:dock`). */
export const dockPresenceSchema = z.strictObject({ showInDock: z.boolean() });

export const OWN_WINDOW_WORDS = {
  /** Something asked of the window while none is open beside a first mate a command started. */
  noWindow: "Infinitary's window is not open on this computer. Open it, then try again.",
  /** Start at login asked while no window is open. */
  noWindowForLogin:
    "Start at login is this computer's own setting, and only Infinitary's window can read or change it. Open Infinitary on this computer, then ask again.",
  /** The window went away before it answered. */
  windowLeft:
    "Infinitary's window on this computer closed before it answered. Open it, then try again.",
} as const;
