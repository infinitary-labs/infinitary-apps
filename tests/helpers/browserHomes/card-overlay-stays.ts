import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

type Input = { titles: string[] };

/** The most cards the test stacks. */
const MOST = 3;

/** Each card's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:cards:thread",
  [`stays-${i + 1}`],
]);

/** The first mate's decisions, the first on top, each with no thread yet and two choices. */
export default function seed(userDataDir: string, { titles }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    for (const [i, title] of titles.entries())
      cards.upsert({
        id: `stays-${i + 1}`,
        author: "firstmate",
        meta: "firstmate",
        priority: 50 - i,
        title,
        body: `<p>Decision ${i + 1} of the overlay's stack.</p>`,
        status: "ready",
        createdAt: i + 1,
        actions: [
          { id: "later", label: "Not now", variant: "secondary" },
          { id: "go", label: "Approve", variant: "primary", default: true },
        ],
      });
  } finally {
    db.close();
  }
}
