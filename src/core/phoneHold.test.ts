import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import type { CardNotice } from "./notifications";
import { systemNoteCard } from "./orchestrator/hostCards";
import { PhoneHold } from "./phoneHold";
import { withdrawable } from "./phonePush";

/**
 * INF-7038's approved plan, Part 2: once the last word that someone is at a
 * computer ends, the phone hears each held moment as its own push, oldest
 * first, in its card's words at that time.
 */
describe("the phone's held notices", () => {
  it("sends each held card once nobody is there, oldest first, in the words it has then", () => {
    let here = true;
    const sent: Pick<CardNotice, "kind" | "cardId" | "title">[] = [];
    const hold = new PhoneHold({
      someoneHere: () => here,
      send: ({ kind, cardId, title }) => sent.push({ kind, cardId, title }),
      switchedOn: () => true,
      words: (card, kind) => ({ kind, cardId: card.id, title: card.title, body: "" }),
      done: withdrawable,
    });
    // As the host's card stack puts them on the stage.
    const launch: Card = {
      ...systemNoteCard("card-launch", "Plan the launch week", "<p>Three fit.</p>"),
      createdAt: 1_000,
    };
    const venue: Card = {
      ...systemNoteCard("card-venue", "Pick a venue", "<p>Two fit.</p>"),
      createdAt: 2_000,
    };
    const notice = (card: Card, kind: CardNotice["kind"]): CardNotice => ({
      kind,
      cardId: card.id,
      title: card.title,
      body: "",
    });

    hold.offer(notice(launch, "card"));
    hold.offer(notice(venue, "card"));
    // The older card replied to meanwhile keeps its place, as its newer moment.
    hold.offer(notice(launch, "reply"));
    hold.observe([{ ...launch, title: "Plan the launch week, moved" }, venue]);
    expect(sent).toEqual([]);

    here = false;
    hold.left();
    expect(sent).toEqual([
      { kind: "reply", cardId: "card-launch", title: "Plan the launch week, moved" },
      { kind: "card", cardId: "card-venue", title: "Pick a venue" },
    ]);
    hold.left();
    expect(sent).toHaveLength(2);
  });
});
