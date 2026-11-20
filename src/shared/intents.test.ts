import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Card, onStage } from "./cards";
import { type CardIntent, cardEvidence, foldCards, type IntentEvidence } from "./intents";

/**
 * INF-2553 (the captain's direction B, "it is the only one with a single place
 * to reason about rollback, conflicts and reconnects"): the shared intent
 * table replays the same fixture as the phone's fold, so every view that takes
 * the table predicts and settles a tap the way the phone does.
 */
type Snapshot = { of: string; with?: Record<string, unknown> }[];
const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/Fixtures/PhoneIntents.json",
    ),
    "utf8",
  ),
) as {
  home: Card[];
  folds: {
    name: string;
    intents: CardIntent[];
    stage: string[];
    aside: string[];
    seen?: string[];
  }[];
  evidence: { name: string; intent: CardIntent; snapshot: Snapshot; says: IntentEvidence }[];
};

function snapshot(entries: Snapshot): Card[] {
  return entries.map(({ of, with: fields }) => {
    const card = fixture.home.find((entry) => entry.id === of);
    if (!card) throw new Error(`The fixture's home holds no card ${of}`);
    return { ...card, ...fields } as Card;
  });
}

describe("the intent table's fold", () => {
  for (const fold of fixture.folds)
    it(fold.name, () => {
      const shown = foldCards(fixture.home, fold.intents);
      expect(
        shown.filter((card) => onStage(card) && !card.minimized).map((card) => card.id),
      ).toEqual(fold.stage);
      expect(shown.filter((card) => card.minimized).map((card) => card.id)).toEqual(fold.aside);
      if (fold.seen)
        expect(
          shown.filter((card) => card.currentUpdateSeen === true).map((card) => card.id),
        ).toEqual(fold.seen);
    });

  it("never edits the snapshot it folds over", () => {
    const before = structuredClone(fixture.home);
    for (const fold of fixture.folds) foldCards(fixture.home, fold.intents);
    expect(fixture.home).toEqual(before);
  });
});

describe("the intent table's evidence", () => {
  for (const entry of fixture.evidence)
    it(entry.name, () => {
      expect(cardEvidence(entry.intent, snapshot(entry.snapshot))).toBe(entry.says);
    });
});
