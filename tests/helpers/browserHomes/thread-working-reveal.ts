import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

type Input = { cardId: string; title: string };

/** The card's thread, empty until the captain replies, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", ["fm-thread-card"]]];

/** The first mate's own decision card, as its emit_card leaves it, with no thread yet. */
export default function seed(userDataDir: string, { cardId, title }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: cardId,
      title,
      body: '<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
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
