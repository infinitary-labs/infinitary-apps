import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "fm-thread-card";

type Input = { title: string; actions: { id: string; label: string; default?: true }[] };

/** The card's thread, empty until the captain replies, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/**
 * The first mate's own decision about how to phrase the welcome, with a
 * setting in its body, as the first mate's turn writes it (cards as
 * threads, phase 2): the captain answers it in its reply row.
 */
export default function seed(userDataDir: string, { title, actions }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: CARD_ID,
      author: "firstmate",
      meta: "firstmate",
      priority: 30,
      title,
      body: '<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
      status: "ready",
      createdAt: Date.now(),
      actions,
    });
  } finally {
    db.close();
  }
}
