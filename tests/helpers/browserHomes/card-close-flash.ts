import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** What the card-close-flash test's story holds: how many ready notes. */
type Input = { count: number };

const TITLES = ["Card close investigation", "The next note"];

/** Each note's thread, which the window reads when the note shows or is prepared. */
export const asked: HomeRead[] = TITLES.map((_, i) => ["inf:cards:thread", [`flash-${i}`]]);

/** Ordinary ready notes from the first mate, the first on top. */
export default function seed(userDataDir: string, { count }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    for (let i = 0; i < count; i++)
      cards.upsert({
        id: `flash-${i}`,
        title: TITLES[i] ?? `Note ${i + 1}`,
        body: "<p>Closing this note should remove it once, without showing it again.</p>",
        author: "firstmate",
        meta: "firstmate",
        priority: 50,
        createdAt: i + 1,
        status: "ready",
        actions: [],
      });
  } finally {
    db.close();
  }
}
