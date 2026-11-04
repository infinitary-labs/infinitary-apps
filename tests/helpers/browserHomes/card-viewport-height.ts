import { decidedCardWidth } from "../../../src/core/pi/cardWidth";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-viewport-height";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/** What the card-viewport-height test's story reads back: the card's title and its body. */
type Words = { title: string; body: string };

/** A crewmate's note whose body is as tall as the viewport, at the width the core decides for it. */
export default function seed(userDataDir: string, { title, body }: Words): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: CARD_ID,
      author: "crewmate",
      meta: "crewmate",
      priority: 15,
      title,
      body,
      width: decidedCardWidth({ body }),
      status: "ready",
      createdAt: Date.now(),
      actions: [],
    });
  } finally {
    db.close();
  }
}
