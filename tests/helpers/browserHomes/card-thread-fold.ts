import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** The first mate's card the card-thread-fold test folds the thread of. */
const CARD_ID = "thread-fold";

/** What the card-thread-fold test's story reads back: the card's title. */
type Input = { title: string };

/** The card's thread, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/**
 * The first mate's decision with a short thread under it, as the captain's
 * reply and the first mate's answer leave it: the thread opens beside the
 * card in a wide window.
 */
export default function seed(userDataDir: string, { title }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    cards.upsert({
      id: CARD_ID,
      author: "firstmate",
      meta: "firstmate",
      priority: 30,
      title,
      body: "<p>Ship the login fix on Tuesday, or wait a week so billing lands with it.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "later", label: "Save for later", variant: "secondary" },
        { id: "go", label: "Approve", variant: "primary", default: true },
      ],
    });
    cards.appendMessage({ cardId: CARD_ID, who: "captain", text: "Keep them together." });
    cards.appendMessage({ cardId: CARD_ID, who: "firstmate", text: "Kept beside it." });
  } finally {
    db.close();
  }
}
