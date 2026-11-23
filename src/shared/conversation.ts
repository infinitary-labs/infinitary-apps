import { z } from "zod";
import { lastTurnReplySchema } from "./lastTurn";
import { throughSchema } from "./through";

/**
 * The conversation (INF-6337's plan, the captain's Approve and build;
 * docs/composer.md "The conversation"): everything the captain did directly
 * and what came back, newest first. A round is one act of the captain's - a
 * message to the first mate, a press of a card's own button, or a line typed
 * under a card - with what answered it. A choice a card's script made, a
 * card put aside or taken down, and anything an agent did alone are not
 * rounds.
 */

/** How many rounds a page holds unless it asks for fewer. */
export const CONVERSATION_PAGE_DEFAULT = 30;
export const CONVERSATION_PAGE_MAX = 100;

/** The card a round acted on, as it stands now. */
export const conversationCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** `cardPresentation`'s kind: the chip the card's head carries. */
  presentation: z.enum(["note", "decision", "attention"]),
  taskId: z.string().optional(),
  /** The task's key, such as INF-12, when the card belongs to a task. */
  taskKey: z.string().optional(),
});
export type ConversationCard = z.infer<typeof conversationCardSchema>;

/** The card author's first line after the captain's, in the card's thread. */
export const conversationAnswerSchema = z.object({
  who: z.enum(["firstmate", "crewmate"]),
  text: z.string(),
  at: z.number(),
});
export type ConversationAnswer = z.infer<typeof conversationAnswerSchema>;

const roundBase = {
  /** Unique and ordered with `at`: the page cursor names it. */
  id: z.string(),
  at: z.number(),
};

export const conversationRoundSchema = z.discriminatedUnion("kind", [
  // A message to the first mate in the main message box.
  z.object({
    ...roundBase,
    kind: z.literal("message"),
    /** The captain's words; empty for a message that was only pictures. */
    you: z.string(),
    /** The first mate's reply, as the strip keeps it; null while none was given. */
    reply: lastTurnReplySchema.nullable(),
    through: throughSchema.optional(),
  }),
  // A press of one of a card's own buttons.
  z.object({
    ...roundBase,
    kind: z.literal("choice"),
    card: conversationCardSchema,
    /** The button's words. */
    label: z.string(),
  }),
  // A line the captain typed under a card.
  z.object({
    ...roundBase,
    kind: z.literal("reply"),
    card: conversationCardSchema,
    you: z.string(),
    answer: conversationAnswerSchema.nullable(),
    /** The first mate's reply line, for a line typed under its own card. */
    reply: lastTurnReplySchema.nullable().optional(),
  }),
]);
export type ConversationRound = z.infer<typeof conversationRoundSchema>;

/** Where a page ends: the oldest round it held. */
export const conversationCursorSchema = z.object({ at: z.number(), id: z.string().max(200) });
export type ConversationCursor = z.infer<typeof conversationCursorSchema>;

export const conversationPageRequestSchema = z.object({
  /** Rounds strictly older than this one; absent reads from the newest. */
  before: conversationCursorSchema.optional(),
  limit: z.number().int().min(1).max(CONVERSATION_PAGE_MAX).optional(),
});
export type ConversationPageRequest = z.infer<typeof conversationPageRequestSchema>;

export const conversationPageSchema = z.object({
  /** Newest first. */
  rounds: z.array(conversationRoundSchema),
  /** Older rounds remain past the last one. */
  more: z.boolean(),
});
export type ConversationPage = z.infer<typeof conversationPageSchema>;

/** Newest first: a later time, then the greater id. */
export function newerRound(a: ConversationCursor, b: ConversationCursor): number {
  if (a.at !== b.at) return b.at - a.at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
