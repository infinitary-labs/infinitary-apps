import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** The one card the work-notice-folds test maximizes over the work notice. */
const CARD_ID = "work-notice-note";

/** What the work-notice-folds test's story reads back: the card's title. */
type Input = { title: string };

/** The card's thread, read when it shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/**
 * One of the first mate's notes, as its turn writes it: the captain
 * maximizes it while the work notice stands under the main message.
 */
export default function seed(userDataDir: string, { title }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: CARD_ID,
      author: "firstmate",
      meta: "firstmate",
      priority: 30,
      title,
      body: "<p>I merged the footer fix; the release notes carry it.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [{ id: "ok", label: "Got it", variant: "primary", default: true }],
    });
  } finally {
    db.close();
  }
}
