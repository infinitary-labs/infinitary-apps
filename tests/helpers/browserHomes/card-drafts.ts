import type { CardAction } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { CardDrafts } from "../../../src/core/orchestrator/cardDrafts";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** The first mate's one card. */
const CARD_ID = "card-drafts";

/** What the card-drafts test's story reads back: the card, and the draft another window left. */
type Input = {
  title: string;
  body: string;
  actions: CardAction[];
  answers: FrameAnswer[];
  words: string;
};

/** The card's thread, read when it shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/**
 * The first mate's own card, with the unsent picks and words another window
 * left in its draft, as the home keeps them across a restart.
 */
export default function seed(
  userDataDir: string,
  { title, body, actions, answers, words }: Input,
): void {
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
    new CardDrafts(db, () => {}).change(CARD_ID, { since: 0, answers, words });
  } finally {
    db.close();
  }
}
