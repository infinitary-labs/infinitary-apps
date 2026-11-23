import { type ConversationRound, type StripRound, stripRounds } from "@shared/conversation";
import type { LastTurn } from "@shared/lastTurn";
import { LAST_TURN_CARD_ROW, LAST_TURN_ROUND } from "./promptGeometry";

/**
 * The strip above the message box (docs/composer.md "The last turn"), as
 * INF-6337's plan set it and the captain chose: the last two rounds at
 * rest, card rounds among them.
 */
export const STRIP_ROUNDS = 2;
export const CARD_ROUNDS_IN_STRIP = true;

/** The conversation's newest page as the strip keeps it, with the message sequence it was read at. */
export type StripPage = { rounds: readonly ConversationRound[]; seq: number };

/** The rounds to draw, oldest first; while a card is up only the newest. */
export function shownStrip(
  state: { lastTurn: LastTurn | null; lastTurnSeq: number; stripPage: StripPage | null },
  cardUp: boolean,
): StripRound[] {
  return stripRounds({
    turn: state.lastTurn,
    seq: state.lastTurnSeq,
    page: state.stripPage,
    limit: cardUp ? 1 : STRIP_ROUNDS,
    cardRounds: CARD_ROUNDS_IN_STRIP,
  });
}

/** A press of a card's button, or a line under a crewmate's card, is one row; a message keeps its reply line. */
export function stripRoundHeight(round: StripRound): number {
  return round.kind === "message" ? LAST_TURN_ROUND : LAST_TURN_CARD_ROW;
}
