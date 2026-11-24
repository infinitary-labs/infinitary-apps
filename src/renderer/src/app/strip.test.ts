import type { ConversationRound } from "@shared/conversation";
import type { LastTurn } from "@shared/lastTurn";
import { describe, expect, it } from "vitest";
import { shownStrip } from "./strip";

/**
 * Intent: INF-6337's plan, the captain's Approve and build: the strip keeps
 * the last two rounds at rest and only the newest while a card is up, a card
 * round included. Fixture: the plan preview's conversation - a reminder sent
 * after a backlog question, then Got it pressed on the backlog card.
 * Failure: a card up leaves both rounds drawn, or the newest is not the
 * press of the card's button.
 */

const turn: LastTurn = {
  you: "also remind me to check usage on friday",
  reply: { text: "All set. I'll remind you Friday at 9:00 AM." },
  previous: {
    you: "can a panel track my backlog?",
    reply: { text: "Yes. I started a plan for it." },
  },
};
const reminded: ConversationRound = {
  id: "a:0000000000000000042",
  at: 3_000,
  kind: "message",
  you: "also remind me to check usage on friday",
  reply: { text: "All set. I'll remind you Friday at 9:00 AM." },
};
const gotIt: ConversationRound = {
  id: "o:0000000000000000008",
  at: 4_000,
  kind: "choice",
  card: {
    id: "card-backlog",
    title: "Your backlog chart",
    presentation: "note",
    taskKey: "INF-12",
  },
  label: "Got it",
};
const state = { lastTurn: turn, lastTurnSeq: 2, stripPage: { rounds: [gotIt, reminded], seq: 2 } };

describe("the strip above the message box", () => {
  it("shows the last two rounds at rest and only the newest, the card round, while a card is up", () => {
    expect(shownStrip(state, false).map((round) => round.key)).toEqual(["m:2", gotIt.id]);
    expect(shownStrip(state, true)).toEqual([
      expect.objectContaining({ kind: "choice", key: gotIt.id, label: "Got it" }),
    ]);
  });
});
