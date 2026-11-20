import type { CardDraft } from "@shared/cardDrafts";
import type { Card } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { describe, expect, it } from "vitest";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { CardDrafts } from "./cardDrafts";

// Intent (INF-5446, the captain's ask): "it would be cool if the answers you
// selected on cards showed up on other devices too (like if you don't finish
// the card completely)" - the first mate's computer keeps each open card's
// unsent picks, words and notes, merges two windows' changes by question,
// and forgets them when the card closes.

const card: Card = {
  id: "card-1",
  taskId: "task-1",
  author: "crewmate",
  priority: 30,
  title: "Choose how the export runs",
  meta: "crewmate 1",
  body: "<fieldset><legend>Format</legend></fieldset>",
  actions: [
    { id: "later", label: "Not now", variant: "ghost" },
    { id: "go", label: "Approve and build", variant: "primary" },
  ],
  status: "ready",
  createdAt: 1000,
};

const pick = (name: string, value: string): FrameAnswer => ({
  name,
  values: [value],
  labels: [value],
  changed: true,
});

function setup() {
  const db = openInMemoryDatabase();
  const cards = new CardStore(db);
  cards.upsert(card);
  const pushed: CardDraft[] = [];
  const drafts = new CardDrafts(db, (draft) => pushed.push(draft));
  return { db, cards, drafts, pushed };
}

function draftOf(result: ReturnType<CardDrafts["change"]>): CardDraft {
  if (!("draft" in result)) throw new Error(`refused: ${result.refused}`);
  return result.draft;
}

describe("CardDrafts", () => {
  it("keeps picks, words and notes for an open card and reads them back after a restart", () => {
    const { db, drafts, pushed } = setup();
    const draft = draftOf(
      drafts.change(card.id, {
        since: 0,
        answers: [pick("format", "csv")],
        words: "Keep the header row",
      }),
    );
    expect(draft).toMatchObject({ revision: 1, words: "Keep the header row" });
    expect(pushed).toEqual([draft]);
    expect(new CardDrafts(db, () => {}).read()).toEqual([draft]);
  });

  it("merges two windows' changes by question and keeps the newer value of the same question", () => {
    const { drafts } = setup();
    // Window A picks a format; window B, which heard nothing yet, picks a schedule.
    draftOf(drafts.change(card.id, { since: 0, answers: [pick("format", "csv")] }));
    const merged = draftOf(
      drafts.change(card.id, { since: 0, answers: [pick("when", "nightly")] }),
    );
    expect(merged.answers.map((a) => a.name).sort()).toEqual(["format", "when"]);
    // Window B, still at revision 0, sends a stale format: A's newer pick stays.
    const kept = draftOf(drafts.change(card.id, { since: 0, answers: [pick("format", "json")] }));
    expect(kept.answers.find((a) => a.name === "format")?.values).toEqual(["csv"]);
    // Having heard revision 2, B's change of format is taken.
    const taken = draftOf(drafts.change(card.id, { since: 2, answers: [pick("format", "json")] }));
    expect(taken.answers.find((a) => a.name === "format")?.values).toEqual(["json"]);
    expect(taken.revision).toBe(3);
  });

  it("pushes only a change that moved something", () => {
    const { drafts, pushed } = setup();
    draftOf(drafts.change(card.id, { since: 0, words: "Ship it" }));
    draftOf(drafts.change(card.id, { since: 1, words: "Ship it" }));
    expect(pushed).toHaveLength(1);
  });

  it("forgets a card's draft when the card is answered or removed, and refuses a late change", () => {
    const { db, cards, drafts } = setup();
    draftOf(drafts.change(card.id, { since: 0, answers: [pick("format", "csv")] }));
    cards.resolve(card.id, "go");
    expect(drafts.read()).toEqual([]);
    expect(drafts.change(card.id, { since: 1, words: "too late" })).toEqual({ refused: "closed" });
    expect(drafts.read()).toEqual([]);

    cards.upsert({ ...card, id: "card-2" });
    draftOf(drafts.change("card-2", { since: 0, words: "draft" }));
    db.prepare("DELETE FROM cards WHERE id = ?").run("card-2");
    expect(drafts.read()).toEqual([]);
    expect(drafts.change("missing", { since: 0, words: "x" })).toEqual({ refused: "closed" });
  });

  it("keeps a draft only in its own table, where no agent, card record or export reads", () => {
    const { db, cards, drafts } = setup();
    const words = "Unsent words about the north basin";
    draftOf(
      drafts.change(card.id, { since: 0, answers: [pick("format", "parquet-unsent")], words }),
    );
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'card_drafts'",
      )
      .all()
      .map((row) => row.name);
    const holding = tables.filter((name) => {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      const text = JSON.stringify(rows);
      return text.includes(words) || text.includes("parquet-unsent");
    });
    expect(holding).toEqual([]);
    expect(JSON.stringify([cards.get(card.id), cards.listOpen()])).not.toContain(words);
  });

  it("refuses answers past what a press may send and keeps nothing of that change", () => {
    const { drafts, pushed } = setup();
    const long = "x".repeat(3000);
    const answers = Array.from({ length: 30 }, (_, i) => pick(`q${i}`, long));
    expect(drafts.change(card.id, { since: 0, answers })).toEqual({ refused: "too-large" });
    expect(drafts.read()).toEqual([]);
    expect(pushed).toEqual([]);
  });
});
