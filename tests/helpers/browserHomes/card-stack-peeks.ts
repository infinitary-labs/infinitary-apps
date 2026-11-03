import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** What the card-stack-peeks test's story holds: how many notes are stacked. */
type Input = { count: number };

/** The most notes the test stacks. */
const MOST = 3;

/** Each note's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:cards:thread",
  [`stacked-${i + 1}`],
]);

/** Ordinary ready notes from the first mate, the first on top. */
export default function seed(userDataDir: string, { count }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    for (let n = 1; n <= count; n++)
      cards.upsert({
        id: `stacked-${n}`,
        author: "firstmate",
        meta: "firstmate",
        priority: 50,
        title: `Stacked card ${n}`,
        body: `<p>Card ${n} of ${count} in the stack.</p>`,
        status: "ready",
        createdAt: n,
        actions: [],
      });
  } finally {
    db.close();
  }
}
