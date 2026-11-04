import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** What the focus-recovery-stack test's story reads back: the stacked notes' titles, top first. */
type Input = { titles: string[] };

/** The most notes the test stacks. */
const MOST = 3;

/** Each note's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:cards:thread",
  [`focus-${i + 1}`],
]);

/** Ordinary ready notes from the first mate, of one priority, the first on top. */
export default function seed(userDataDir: string, { titles }: Input): void {
  if (titles.length > MOST) throw new Error(`The seed stacks at most ${MOST} notes`);
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    for (const [index, title] of titles.entries())
      cards.upsert({
        id: `focus-${index + 1}`,
        author: "firstmate",
        priority: 25,
        title,
        meta: "firstmate",
        body: `<p>${title} body.</p>`,
        actions: [],
        status: "ready",
        createdAt: 1000 + index,
      });
  } finally {
    db.close();
  }
}
