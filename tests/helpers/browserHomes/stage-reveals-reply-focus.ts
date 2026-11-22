import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

type Input = { cardId: string; title: string };

/** The card's thread, empty until the captain replies, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", ["lone"]]];

/** A lone note of the first mate's, the only card on the stack. */
export default function seed(userDataDir: string, { cardId, title }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: cardId,
      author: "firstmate",
      meta: "firstmate",
      priority: 25,
      title,
      body: "<p>Two questions follow.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000,
    });
  } finally {
    db.close();
  }
}
