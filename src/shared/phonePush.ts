import { z } from "zod";
import { KEY_TEXT_PATTERN } from "./devices";

/**
 * Card pushes to a phone (docs/phone-push.md): the shapes a paired phone,
 * its computer and Infinitary's relay agree on. The computer seals each card
 * for one phone under that phone's own key; the relay forwards bytes it
 * cannot read.
 */

/** Where a computer posts every card push: Infinitary's relay (docs/architecture.md §1). */
export const PHONE_PUSH_RELAY = "https://push.getinfinitary.com/v1/push";

/**
 * Where a computer posts a withdrawal, beside `PHONE_PUSH_RELAY` on the same
 * relay (or a development run's stand-in): its `withdraw` request.
 */
export function phoneWithdrawRelay(pushRelay: string): string {
  return new URL("withdraw", pushRelay).toString();
}

/**
 * Which of Apple's push services a phone's address belongs to: production for
 * TestFlight and App Store builds, development (Apple's sandbox) for builds
 * signed for development.
 */
export const phonePushEnvironmentSchema = z.enum(["production", "development"]);

/**
 * What a paired phone hands its computer (`inf:devices:push`): its push
 * address from Apple and which service it belongs to, the grant the relay
 * sent that address by a background push, and the AES-256-GCM key it seals
 * with, 32 random bytes in base64url. The computer keeps it beside the
 * phone's device entry and forgets it with the entry. The token and grant
 * take the relay's own shapes, so a registration the relay would refuse is
 * refused here.
 */
export const phonePushRegistrationSchema = z.strictObject({
  /** The phone's push address from Apple, lowercase hexadecimal. */
  token: z.string().regex(/^(?:[0-9a-f]{2}){32,100}$/),
  environment: phonePushEnvironmentSchema,
  /** The relay's grant for that address: its expiry, a dot and its signature. */
  grant: z.string().regex(/^\d{10}\.[A-Za-z0-9_-]{43}$/),
  /** The phone's sealing key, 32 bytes in base64url. */
  key: z.string().regex(KEY_TEXT_PATTERN),
  /**
   * The phone removes notifications a withdrawal names (contract change
   * `phone-push-withdraw`). A phone sends it only to a computer that lists
   * that change, since an older computer's registration refuses it.
   */
  withdrawals: z.literal(true).optional(),
});
export type PhonePushRegistration = z.infer<typeof phonePushRegistrationSchema>;

/** One phone the computer pushes to (`DevicePairing.pushTargets`), with its registration. */
export type PhonePushTarget = {
  deviceId: string;
  registration: PhonePushRegistration;
};

/**
 * What the computer answers a phone's registration: whether it keeps it.
 * False for null, and for a grant the relay already refused this run (it
 * expired, the relay's key changed, or Apple no longer takes the address):
 * then the phone gets a new registration from the relay and hands that.
 * Registering costs the phone one of Apple's background pushes, so the phone
 * registers only on this answer, near its grant's expiry, or when its push
 * address or environment changed, and hands what it holds on each welcome.
 */
export const phonePushAnswerSchema = z.strictObject({ kept: z.boolean() });
export type PhonePushAnswer = z.infer<typeof phonePushAnswerSchema>;

/**
 * What one sealed push says once the phone opens it: a new card or an
 * answered reply, the card to open on a tap, and the words the Mac's own
 * notification shows.
 */
export const phonePushCardSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(["card", "reply"]),
  cardId: z.string(),
  title: z.string(),
  body: z.string(),
  /**
   * This push's own random name, never given to another: a withdrawal names
   * the pushes it withdraws, so the phone keeps any other push of the same
   * card, such as a newer reply. An older computer sends none, and a
   * notification without one is never withdrawn.
   */
  push: z.string().min(1).optional(),
});
export type PhonePushCard = z.infer<typeof phonePushCardSchema>;

/**
 * What one sealed withdrawal says once the phone opens it: the cards whose
 * notifications the phone removes, newest first, each with the pushes of it
 * that were withdrawn (`PhonePushCard.push`); the phone removes only those,
 * so another push of the same card keeps its notification. It names every
 * card withdrawn since the phone last handed its registration, as many as
 * fit, because iOS keeps only the newest silent push for an app.
 */
export const phonePushWithdrawalSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("withdraw"),
  cards: z.array(z.strictObject({ cardId: z.string(), pushes: z.array(z.string().min(1)) })),
});
export type PhonePushWithdrawal = z.infer<typeof phonePushWithdrawalSchema>;

/**
 * What the computer posts to the relay, a card push or a withdrawal alike:
 * nothing the relay could read of the cards.
 */
export const phonePushRelayRequestSchema = z.strictObject({
  token: z.string(),
  environment: phonePushEnvironmentSchema,
  grant: z.string(),
  /** base64url of the 12-byte nonce, then the ciphertext, then the 16-byte tag. */
  sealed: z.string(),
});
export type PhonePushRelayRequest = z.infer<typeof phonePushRelayRequestSchema>;
