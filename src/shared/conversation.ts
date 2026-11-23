import { z } from "zod";
import { type LastRound, type LastTurn, lastTurnReplySchema } from "./lastTurn";
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
    /**
     * The first mate's reply line, for a line typed under its own card, which
     * is also a message (null while none was given); absent on any other line.
     */
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

/** A round the captain sent as a message, as the strip's rounds are: one typed under a card included. */
export function sentAsMessage(round: ConversationRound): boolean {
  return round.kind === "message" || (round.kind === "reply" && round.reply !== undefined);
}

/**
 * One round the strip above the message box draws (docs/composer.md "The
 * last turn"). A message keeps the window's live round - its reply line and
 * working mark - and, when it was typed under the first mate's own card,
 * that card. A press of a card's button or a line typed under a crewmate's
 * card draws as one row with the card's name.
 */
export type StripRound = {
  /** Stable while the round stays on the strip: a message's place in the window's sequence, else the round's id. */
  key: string;
  /** The conversation round's id once a read holds it: the conversation opens there. */
  id?: string;
  /** The card the round acted on. */
  card?: ConversationCard;
} & (
  | { kind: "message"; round: LastRound }
  | { kind: "choice"; label: string }
  | { kind: "reply"; you: string }
);

/** The window's messages and the newest page of the conversation, as the strip reads them. */
export type StripInput = {
  turn: LastTurn | null;
  /** The newest message's place in the window's sequence. */
  seq: number;
  /**
   * The newest page and the `seq` it was read at; null while none was read
   * or on a home that refuses the read, and the strip shows messages alone.
   */
  page: { rounds: readonly ConversationRound[]; seq: number } | null;
  /** How many rounds the strip shows. */
  limit: number;
  /** Whether card rounds take a place on the strip (INF-6337's plan, the captain's choice: shown). */
  cardRounds: boolean;
};

/**
 * The strip's rounds, oldest first: the newest `limit` of the window's
 * messages and the page's card rounds, by time.
 *
 * A message's time comes from the page: the page's messages, newest first,
 * are the window's messages after the ones sent since it was read (`seq`
 * past the page's). A message sent since is newer than every round the page
 * holds; a message the page does not reach is older than all of them.
 */
export function stripRounds(input: StripInput): StripRound[] {
  const { turn, seq, page, limit } = input;
  const messages = turn ? [turn, ...(turn.previous ? [turn.previous] : [])] : [];
  const lag = page ? seq - page.seq : 0;
  const sent = page ? page.rounds.filter(sentAsMessage) : [];
  const timed: { at: number; order: number; round: StripRound }[] = messages.map((said, i) => {
    const round: LastRound = {
      you: said.you,
      reply: said.reply,
      ...(said.through ? { through: said.through } : {}),
    };
    const key = `m:${seq - i}`;
    if (!page) return { at: -i, order: i, round: { key, kind: "message", round } };
    const read = i - lag < 0 ? undefined : sent[i - lag];
    const at = i - lag < 0 ? Number.POSITIVE_INFINITY : read ? read.at : Number.NEGATIVE_INFINITY;
    return {
      at,
      order: i,
      round: {
        key,
        kind: "message",
        round,
        ...(read ? { id: read.id } : {}),
        ...(read?.kind === "reply" ? { card: read.card } : {}),
      },
    };
  });
  if (page && input.cardRounds)
    page.rounds.forEach((read, order) => {
      if (read.kind === "message" || sentAsMessage(read)) return;
      const base = { key: read.id, id: read.id, card: read.card };
      timed.push({
        at: read.at,
        order,
        round:
          read.kind === "choice"
            ? { ...base, kind: "choice", label: read.label }
            : { ...base, kind: "reply", you: read.you },
      });
    });
  timed.sort((a, b) => b.at - a.at || a.order - b.order);
  return timed
    .slice(0, limit)
    .reverse()
    .map((entry) => entry.round);
}
