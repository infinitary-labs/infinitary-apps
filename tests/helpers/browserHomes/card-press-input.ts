import type { CardAction } from "@shared/cards";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "press-input";

type Input = { title: string; body: string; actions: CardAction[] };

/** The card's thread, read when it shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/** The first mate's own card, restored from a saved home as the window opens. */
export default function seed(userDataDir: string, { title, body, actions }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: CARD_ID,
      title,
      author: "firstmate",
      priority: 50,
      meta: "firstmate",
      body,
      status: "ready",
      createdAt: Date.now(),
      actions,
    });
  } finally {
    db.close();
  }
}
