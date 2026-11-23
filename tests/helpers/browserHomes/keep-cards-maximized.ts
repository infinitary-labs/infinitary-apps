import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

const CARD_IDS = ["keep-plan", "keep-window"] as const;

type Input = { titles: [string, string] };

/** Each card's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = CARD_IDS.map((id) => ["inf:cards:thread", [id]]);

/**
 * Two of the first mate's decisions, as its turn writes them, so the stack
 * has a pager: the captain maximizes the first and pages to the second, which
 * comes forward maximized while Keep cards maximized is on.
 */
export default function seed(userDataDir: string, { titles }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    for (const [n, id] of CARD_IDS.entries())
      cards.upsert({
        id,
        author: "firstmate",
        meta: "firstmate",
        priority: 30 - n,
        title: titles[n] as string,
        body: "<p>I recommend the second plan: it keeps billing and login in one release.</p>",
        status: "ready",
        createdAt: Date.now() + n,
        actions: [
          { id: "later", label: "Save for later", variant: "secondary" },
          { id: "go", label: "Approve", variant: "primary", default: true },
        ],
      });
  } finally {
    db.close();
  }
}
