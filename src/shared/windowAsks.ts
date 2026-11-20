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
  /**
   * For a change to a shared value, the fields the named action may change:
   * the window applies them over its own value as it is then.
   */
  fields: z.array(z.string().min(1).max(64)).max(16).optional(),
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
    `Infinitary's window on ${name} was asked but did not answer in time, so it may or may not have made the change. Look at its Settings before asking again.`,
  badAnswer: (name: string) =>
    `Infinitary's window on ${name} answered in a way this computer does not read, so it may or may not have made the change. Look at its Settings before asking again.`,
  notAsked: "That is not something the first mate asks of a window.",
} as const;

/** The read that answers a shared value's whole, for a window applying only named fields. */
export const WINDOW_VALUE_OF: Partial<Record<WindowChannel, WindowChannel>> = {
  "inf:settings:appearance:set": "inf:settings:appearance:get",
  "inf:settings:layout:set": "inf:settings:layout:get",
};

/**
 * The request a window runs for an ask with named fields: those fields from
 * the asked value over its own value now, every other field as it is there.
 */
export function namedFieldsOver(
  own: Record<string, unknown>,
  asked: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const next = { ...own };
  for (const field of fields) {
    if (field.includes("=")) continue;
    if (Object.hasOwn(asked, field)) next[field] = asked[field];
    else delete next[field];
  }
  return next;
}
