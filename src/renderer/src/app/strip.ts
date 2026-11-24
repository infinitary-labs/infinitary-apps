import { type StripPage, type StripRound, stripRounds } from "@shared/conversation";
import type { LastTurn } from "@shared/lastTurn";
import { LAST_TURN_CARD_ROW, LAST_TURN_ROUND } from "./promptGeometry";

/**
 * The strip above the message box (docs/composer.md "The last turn"), as
 * INF-6337's plan set it and the captain chose: the last two rounds at
 * rest, card rounds among them.
 */
export const STRIP_ROUNDS = 2;

/** The rounds to draw, oldest first; while a card is up only the newest. */
export function shownStrip(
  state: { lastTurn: LastTurn | null; lastTurnSeq: number; stripPage: StripPage | null },
  cardUp: boolean,
): StripRound[] {
  const strip = stripRounds({
    turn: state.lastTurn,
    seq: state.lastTurnSeq,
    page: state.stripPage,
    limit: STRIP_ROUNDS,
  });
  return cardUp ? strip.slice(-1) : strip;
}

/** A press of a card's button, or a line under a crewmate's card, is one row; a message keeps its reply line. */
export function stripRoundHeight(round: StripRound): number {
  return round.kind === "message" ? LAST_TURN_ROUND : LAST_TURN_CARD_ROW;
}
