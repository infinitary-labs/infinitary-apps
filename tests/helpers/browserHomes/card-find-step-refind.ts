import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-find";

/** What the card-find-step-refind test's story reads back: the card's words and its thread's question. */
type Input = { title: string; body: string; question: string };

/** The card's thread, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/**
 * The first mate's decision the card-find journey finds in: a body long
 * enough to scroll, its last match in a folded section, and the captain's
 * question in its thread, before the first mate's answer comes.
 */
export default function seed(userDataDir: string, { title, body, question }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    cards.upsert({
      id: CARD_ID,
      author: "firstmate",
      meta: "first mate",
      priority: 30,
      title,
      body,
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "later", label: "Save for later", variant: "secondary" },
        { id: "go", label: "Approve", variant: "primary", default: true },
      ],
    });
    cards.appendMessage({ cardId: CARD_ID, who: "captain", text: question });
  } finally {
    db.close();
  }
}
