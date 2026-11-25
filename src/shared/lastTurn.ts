import { z } from "zod";
import { throughSchema } from "./through";

/**
 * The last turn above the input (FI3-1089's plan, the captain's Approve and
 * build; docs/composer.md "The last turn"): the captain's last message and
 * the Firstmate's reply line beside it, one line each.
 *
 * The reply line is typed, never the closing words: the Firstmate's own
 * emote words, else the title of the card it showed, else the title of the
 * work it started, else the app's own words for what took effect. A failed
 * turn's line is the plain words for the problem (`problem`).
 */
/**
 * Whether a reply line may fade (docs/composer.md "The last turn").
 * `completed` is a finished acknowledgment. `queued` is a receipt for a
 * message the paused seat keeps. Absent means unknown, an older saved
 * line, and the line stays.
 */
export const lastTurnEligibilitySchema = z.enum(["completed", "queued"]);
export type LastTurnEligibility = z.infer<typeof lastTurnEligibilitySchema>;

export const lastTurnReplySchema = z.object({
  text: z.string(),
  /** The turn failed or paused: the line says what went wrong, in plain words. */
  problem: z.boolean().optional(),
  /** Typed, never inferred from the words. Absent is unknown, and the line stays. */
  eligibility: lastTurnEligibilitySchema.optional(),
  /**
   * The Firstmate's closing words as it wrote them, line breaks kept, when
   * they differ from the one-line `text`: the conversation shows them
   * (docs/composer.md "The conversation"). Absent, it shows `text`.
   */
  words: z.string().optional(),
});
export type LastTurnReply = z.infer<typeof lastTurnReplySchema>;

/** One round: a message of the captain's and the reply line kept beside it. */
export const lastRoundSchema = z.object({
  /** The captain's words; empty for a message that was only pictures. */
  you: z.string(),
  /** The Firstmate's reply line, or null while none has been given. */
  reply: lastTurnReplySchema.nullable(),
  /** The message came from the captain's own command, `infinitary-axi`, not the window. */
  through: throughSchema.optional(),
  /** The message's id, which a take back names; absent from an older core. */
  askId: z.string().optional(),
  /**
   * When the core accepted the message, in ms since the epoch: the take-back
   * window runs from it (`TAKE_BACK_WINDOW_MS`). Absent from an older core.
   */
  sentAt: z.number().optional(),
  /** The captain took the message back (docs/task-capture.md, "Taking back a message"). */
  takenBack: z.literal(true).optional(),
});
export type LastRound = z.infer<typeof lastRoundSchema>;

/**
 * The newest round, with the round before it (INF-1771, the captain's
 * Approve and build on INF-1770's plan: the last two rounds, the older one
 * faded). `previous` is absent from an older core and null before a second
 * message.
 */
export const lastTurnSchema = lastRoundSchema.extend({
  previous: lastRoundSchema.nullable().optional(),
});
export type LastTurn = z.infer<typeof lastTurnSchema>;
