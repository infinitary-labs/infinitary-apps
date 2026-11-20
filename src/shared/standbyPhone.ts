import { z } from "zod";
import { deviceNameSchema, dialAddressSchema, PAIRING_LINK_ALSO_MAX } from "./devices";

/**
 * Taking over from the phone (docs/devices.md, "Taking over from a phone";
 * docs/ios.md, "Taking over"): every welcome a phone hears names each
 * computer that keeps a copy, with its own key and where it listens for the
 * other copies, so a phone that cannot reach the home reaches each copy
 * there, hears what Take over is based on, and asks one to take over once
 * the person confirmed it with Face ID or the passcode.
 *
 * The contract change that carries it is `standby-phone`
 * (`src/shared/contract-changes/standby-phone.md`).
 */

/** The contract change's name (`src/shared/contract-changes/standby-phone.md`). */
export const STANDBY_PHONE_CHANGE = "standby-phone";

/** The path a phone's link to a copy upgrades on, beside the copies' own `/copies`. */
export const STANDBY_PHONE_PATH = "/phone";

/** The largest frame on a phone's link: an answer is a few facts, never a file. */
export const STANDBY_PHONE_FRAME_BYTES = 64 * 1024;

/**
 * One computer that keeps a copy, as a welcome tells a phone: its id and
 * name on the home's list, the pin of the key it joined with, which a link
 * to it checks, and where it listens for the other copies. `listens` is
 * empty until that computer said where.
 */
export const phoneStandbySchema = z.object({
  deviceId: z.string().min(1).max(64),
  name: deviceNameSchema,
  pin: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  listens: z.array(dialAddressSchema).max(PAIRING_LINK_ALSO_MAX + 1),
});
export type PhoneStandby = z.infer<typeof phoneStandbySchema>;

/** Every computer that keeps a copy and said where it listens, as a welcome or `inf:home:routes` lists them for a phone. */
export const phoneStandbysSchema = z.array(phoneStandbySchema).max(64);

/** How the work there answered a takeover: still running, started, or refused, in its words. */
export const takeOverAskedSchema = z.object({
  state: z.enum(["running", "started", "refused"]),
  text: z.string().min(1).max(600),
});

export const STANDBY_PHONE_OFFER = "inf:standby:offer";
export const STANDBY_PHONE_TAKE_OVER = "inf:standby:take-over";

/**
 * What a copy tells a phone Take over is based on, as its own window shows
 * it: when its copy is from, where the home stands as this computer hears
 * it (still in reach, out of reach since when, quit, or said it went to
 * sleep), the home number it heard, every other copy as the home last said
 * it with whether it may be newer, whether the home told it what taking
 * over needs, and its answer to the last ask.
 */
export const phoneOfferSchema = z.object({
  /** When its copy is from; null while it holds no whole copy. */
  copyAt: z.number().int().nonnegative().nullable(),
  home: z.object({
    name: z.string().max(160).nullable(),
    contact: z.enum(["reaching", "in-reach", "lost", "closed"]),
    /** When this computer last heard the home. */
    heardAt: z.number().int().nonnegative().nullable(),
    /** The home said it went to sleep before this computer lost it. */
    slept: z.boolean(),
  }),
  homeNumber: z.number().int().positive(),
  copies: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        copyAt: z.number().int().nonnegative().nullable(),
        newer: z.boolean(),
      }),
    )
    .max(64),
  ready: z.boolean(),
  asked: takeOverAskedSchema.nullable(),
});
export type PhoneOffer = z.infer<typeof phoneOfferSchema>;

/** The orders a phone asks a copy over its link. */
export const standbyPhoneOrders = {
  [STANDBY_PHONE_OFFER]: {
    effect: "read",
    request: z.tuple([]),
    response: phoneOfferSchema,
  },
  /**
   * The person's Take over, confirmed on the phone: `id` names the ask, so
   * one asked again after a dropped link is the same takeover. Answered once
   * the work there started the first mate or refused; while it still runs
   * the answer says so.
   */
  [STANDBY_PHONE_TAKE_OVER]: {
    effect: "change",
    request: z.tuple([z.object({ id: z.string().uuid() })]),
    response: takeOverAskedSchema,
  },
} as const;
export type StandbyPhoneOrderChannel = keyof typeof standbyPhoneOrders;
export function isStandbyPhoneOrderChannel(channel: string): channel is StandbyPhoneOrderChannel {
  return Object.hasOwn(standbyPhoneOrders, channel);
}

/** One frame on a phone's link to a copy, as JSON text: the phone asks, the copy answers by id. */
export const phoneLinkFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("ask"),
    id: z.number().int().nonnegative(),
    channel: z.string().min(1).max(64),
    args: z.array(z.unknown()).max(4),
  }),
  z.object({ t: z.literal("answer"), id: z.number().int().nonnegative(), value: z.unknown() }),
  z.object({
    t: z.literal("refused"),
    id: z.number().int().nonnegative(),
    error: z.string().max(600),
  }),
]);
export type PhoneLinkFrame = z.infer<typeof phoneLinkFrameSchema>;
