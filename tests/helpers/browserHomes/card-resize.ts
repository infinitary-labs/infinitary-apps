import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-resize";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

type Words = { title: string; body: string };

/**
 * FI3-234's card: a crewmate's note holding one fluid drawing, saved at the
 * regular column - the width the captain's drag gave it in the reproduction.
 */
export default function seed(userDataDir: string, { title, body }: Words): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: CARD_ID,
      author: "firstmate",
      meta: "firstmate",
      priority: 15,
      title,
      body,
      width: "regular",
      status: "ready",
      createdAt: Date.now(),
      actions: [],
    });
  } finally {
    db.close();
  }
}
