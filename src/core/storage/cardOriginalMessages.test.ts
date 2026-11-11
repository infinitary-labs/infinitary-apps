import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { initOverflowDir, withPastedFiles } from "../overflow";
import { CardStore } from "./cardStore";
import { type AppDatabase, openInMemoryDatabase } from "./db";

/**
 * Intent: the approved correction plan uses source-time nearby messages,
 * not a later thread or attachment decoration. Actual message/file producers
 * and disposable SQLite records own this read boundary; no model judgment
 * or recognition quality is asserted here.
 */
const databases: AppDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = openInMemoryDatabase();
  databases.push(db);
  const cards = new CardStore(db);
  for (const id of ["source-card", "other-card"]) {
    cards.upsert({
      id,
      author: "firstmate",
      priority: 30,
      title: "Review this approach",
      meta: "first mate",
      body: "<p>The proposed approach.</p>",
      actions: [{ id: "continue", label: "Continue", default: true }],
      status: "ready",
      createdAt: 1_000,
    });
  }
  return cards;
}

describe("source-owner thread reads", () => {
  it("seeks only the frozen earlier thread and uses known original captions", () => {
    const cards = fixture();
    initOverflowDir(scratchDir("card-original-context-"));
    const caption = "For the next 3 reviews, keep the proposed scope unchanged.";
    const decorated = withPastedFiles(caption, [
      { name: "example.txt", text: "This attached example is not the captain's instruction." },
    ]);
    const legacy = cards.appendMessage({ cardId: "source-card", who: "captain", text: decorated });
    const known = cards.appendMessage({
      cardId: "source-card",
      who: "captain",
      text: decorated,
      captainText: caption,
    });
    cards.appendMessage({
      cardId: "other-card",
      who: "captain",
      text: "A different discussion.",
      captainText: "A different discussion.",
    });
    const author = cards.appendMessage({
      cardId: "source-card",
      who: "firstmate",
      text: "The current proposal is ready for review.",
    });
    const cursor = cards.latestMessageId("source-card");
    cards.appendMessage({
      cardId: "source-card",
      who: "captain",
      text: "The current reply must not appear in its own preceding context.",
      captainText: "The current reply must not appear in its own preceding context.",
    });
    cards.appendMessage({
      cardId: "source-card",
      who: "firstmate",
      text: "A later answer cannot change what was known before that reply.",
    });
    expect([...cards.originalMessagesBefore("source-card", cursor)]).toEqual([
      { id: author.id, who: author.who, text: author.text },
      { id: known.id, who: known.who, text: caption },
      { id: legacy.id, who: legacy.who, text: undefined },
    ]);
    expect([...cards.originalMessagesBefore("source-card", 0)]).toEqual([]);
  });

  it("lets the caller stop the seek before reading an older exchange", () => {
    const cards = fixture();
    cards.appendMessage({ cardId: "source-card", who: "firstmate", text: "The earlier proposal." });
    const last = cards.appendMessage({
      cardId: "source-card",
      who: "captain",
      text: "Use the next 3 reviews.",
      captainText: "Use the next 3 reviews.",
    });
    const read = cards.originalMessagesBefore("source-card", last.id);
    expect(read.next()).toEqual({
      done: false,
      value: { id: last.id, who: last.who, text: "Use the next 3 reviews." },
    });
    read.return(undefined);
    expect(read.next().done).toBe(true);
    // Closing the iterator releases its statement; the same owner can write again.
    expect(
      cards.appendMessage({ cardId: "source-card", who: "firstmate", text: "A later proposal." })
        .id,
    ).toBeGreaterThan(last.id);
  });
});
