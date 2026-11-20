import { z } from "zod";

/**
 * What the first mate asks of a window's own computer (docs/view.md, "What
 * the first mate asks of a window"): the look, the panels' layout, the
 * update and the key reminder are each computer's own, so a change the
 * captain asks for on a Mac that controls this one, or a key reminder on
 * any computer, is asked of that computer's window over its connection, and
 * the window answers it as its own Settings would.
 */
export const WINDOW_CHANNELS = [
  "inf:settings:appearance:get",
  "inf:settings:appearance:set",
  "inf:settings:layout:get",
  "inf:settings:layout:set",
  "inf:update:status",
  "inf:update:check",
  "inf:update:channel",
  "inf:keyboard:reminders",
  "inf:keyboard:reminders:set",
] as const;
export type WindowChannel = (typeof WINDOW_CHANNELS)[number];

export function isWindowChannel(channel: string): channel is WindowChannel {
  return (WINDOW_CHANNELS as readonly string[]).includes(channel);
}

/** A key reminder lives only in a window's own program, so even this computer's is asked of its window. */
export const WINDOW_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  "inf:keyboard:reminders",
  "inf:keyboard:reminders:set",
]);

/** The live frame that carries one ask to the window of one computer. */
export const WINDOW_ASK_LIVE = "inf:view:ask";

export const windowAskSchema = z.strictObject({
  id: z.string().min(1).max(64),
  /** The window's own device id; every other window ignores the ask. */
  deviceId: z.string().min(1).max(64),
  channel: z.enum(WINDOW_CHANNELS),
  args: z.array(z.unknown()).max(4),
});
export type WindowAsk = z.infer<typeof windowAskSchema>;

export const windowAnswerSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ ok: z.literal(false), message: z.string().min(1).max(400) }),
]);
export type WindowAnswer = z.infer<typeof windowAnswerSchema>;

/** How long the first mate waits for a window's answer before saying it did not come. */
export const WINDOW_ANSWER_WAIT_MS = 30_000;

export const WINDOW_ASK_WORDS = {
  noWindow: (name: string) =>
    `Infinitary's window on ${name} is not connected now, or is from before it could be asked this. Open it there, then ask again.`,
  noAnswer: (name: string) =>
    `Infinitary's window on ${name} did not answer. Nothing is known to have changed there.`,
  notAsked: "That is not something the first mate asks of a window.",
} as const;
