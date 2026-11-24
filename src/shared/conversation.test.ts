import { describe, expect, it } from "vitest";
import { type ConversationRound, stripRounds } from "./conversation";
import type { LastTurn } from "./lastTurn";

/**
 * Intent: INF-6337's plan, the captain's Approve and build, part 2: a press
 * of a card's button or a line typed under a card shows above the message
 * box with the card's name, among the messages by time, and a press opens
 * the conversation at that round. Fixture: the conversation of the plan's
 * own preview - a question about a backlog panel answered with a card the
 * captain approved, then a reminder. Failure: a card round missing, out of
 * order, without its card or id, or a message drawn twice.
 */

const BACKLOG_CARD = {
  id: "card-backlog",
  title: "A panel that charts your backlog",
  presentation: "decision" as const,
  taskKey: "INF-12",
};

const asked: ConversationRound = {
  id: "a:0000000000000000041",
  at: 1_000,
  kind: "message",
  you: "can a panel track my backlog?",
  reply: { text: "Yes. I started a plan for it." },
};
const approved: ConversationRound = {
  id: "o:0000000000000000007",
  at: 2_000,
  kind: "choice",
  card: BACKLOG_CARD,
  label: "Approve and build",
};
const reminded: ConversationRound = {
  id: "a:0000000000000000042",
  at: 3_000,
  kind: "message",
  you: "also remind me to check usage on friday",
  reply: { text: "All set. I'll remind you Friday at 9:00 AM." },
};

const turn: LastTurn = {
  you: "also remind me to check usage on friday",
  reply: { text: "All set. I'll remind you Friday at 9:00 AM." },
  previous: {
    you: "can a panel track my backlog?",
    reply: { text: "Yes. I started a plan for it." },
  },
};

const shown = (rounds: ReturnType<typeof stripRounds>) =>
  rounds.map((round) => `${round.kind}:${round.key}:${round.card?.title ?? ""}`);

describe("the strip's rounds", () => {
  it("puts a press of a card's button among the messages by time, with its card and id", () => {
    const page = { rounds: [approved, asked], seq: 1 };
    const prev = { you: "can a panel track my backlog?", reply: asked.reply };
    const strip = stripRounds({
      turn: { ...prev, previous: null },
      seq: 1,
      page,
      limit: 2,
    });
    expect(shown(strip)).toEqual(["message:m:1:", `choice:${approved.id}:${BACKLOG_CARD.title}`]);
    expect(strip[1]).toMatchObject({ id: approved.id, kind: "choice", label: "Approve and build" });
    expect(strip[0]).toMatchObject({ id: asked.id });
  });

  it("shows a message sent since the page was read as the newest, above it the newest the page holds", () => {
    // The reminder is sent; the page read before it still holds the choice as its newest.
    const strip = stripRounds({
      turn,
      seq: 2,
      page: { rounds: [approved, asked], seq: 1 },
      limit: 2,
    });
    expect(shown(strip)).toEqual([`choice:${approved.id}:${BACKLOG_CARD.title}`, "message:m:2:"]);
    // Read again, the same rounds keep their keys, and the message gains its id.
    const read = stripRounds({
      turn,
      seq: 2,
      page: { rounds: [reminded, approved], seq: 2 },
      limit: 2,
    });
    expect(shown(read)).toEqual(shown(strip));
    expect(read[1]).toMatchObject({ id: reminded.id });
  });

  it("draws a line typed under the first mate's own card once, as a message that names the card", () => {
    const typed: ConversationRound = {
      id: "a:0000000000000000043",
      at: 4_000,
      kind: "reply",
      card: BACKLOG_CARD,
      you: "make it weekly",
      answer: null,
      reply: { text: "Weekly it is." },
    };
    const strip = stripRounds({
      turn: { you: "make it weekly", reply: { text: "Weekly it is." }, previous: turn },
      seq: 3,
      page: { rounds: [typed, reminded], seq: 3 },
      limit: 2,
    });
    expect(shown(strip)).toEqual(["message:m:2:", `message:m:3:${BACKLOG_CARD.title}`]);
  });

  it("draws a line typed under a crewmate's card as a card row with its words", () => {
    const line: ConversationRound = {
      id: "m:0000000000000000009",
      at: 4_000,
      kind: "reply",
      card: { id: "card-crew", title: "Weekly usage check", presentation: "note" },
      you: "thanks, looks right",
      answer: null,
    };
    const strip = stripRounds({
      turn,
      seq: 2,
      page: { rounds: [line, reminded], seq: 2 },
      limit: 2,
    });
    expect(strip.at(-1)).toMatchObject({ kind: "reply", you: "thanks, looks right", id: line.id });
  });

  it("keeps to messages on a home that refuses the read", () => {
    expect(shown(stripRounds({ turn, seq: 2, page: null, limit: 2 }))).toEqual([
      "message:m:1:",
      "message:m:2:",
    ]);
  });
});
