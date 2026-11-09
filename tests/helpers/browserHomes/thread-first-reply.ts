import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** What the thread-first-reply test's story reads back. */
type Input = { cardId: string; title: string };

/** The card's thread, empty until the captain replies, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", ["fm-thread-card"]]];

/**
 * The first mate's own decision card, as its emit_card leaves it, with no
 * thread yet: a body long enough to fill the card, as a card that explains
 * its choice does, and its two choices.
 */
export default function seed(userDataDir: string, { cardId, title }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: cardId,
      title,
      body: "<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><p>Someone opening the welcome cold reads the caption first and decides from it whether to read on.</p><p>The chips name what the app can do, which matters once they have decided to stay.</p><p>Leading with the chips asks them to choose before they know why.</p><p>Leading with the caption tells them why first, then offers the choices.</p><p>Either way the same words are on the screen; only their order changes.</p>",
      author: "firstmate",
      meta: "firstmate",
      priority: 50,
      createdAt: Date.now(),
      status: "ready",
      actions: [
        { id: "chips-first", label: "Lead with the chips" },
        { id: "caption-first", label: "Lead with the caption", default: true },
      ],
    });
  } finally {
    db.close();
  }
}
