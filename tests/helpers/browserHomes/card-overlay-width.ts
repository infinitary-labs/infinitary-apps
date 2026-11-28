import { decidedCardWidth } from "../../../src/core/pi/cardWidth";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

type Shown = { title: string; body: string };

type Input = { notes: Shown[] };

const MOST = 2;

/** Each note's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:cards:thread",
  [`overlay-width-${i + 1}`],
]);

/** The first mate's notes, the first on top, each as wide as the host decides at emit (`decidedCardWidth`). */
export default function seed(userDataDir: string, { notes }: Input): void {
  if (notes.length > MOST) throw new Error(`The seed shows at most ${MOST} notes`);
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    for (const [i, note] of notes.entries()) {
      const width = decidedCardWidth(note);
      cards.upsert({
        id: `overlay-width-${i + 1}`,
        author: "firstmate",
        meta: "firstmate",
        priority: 50,
        title: note.title,
        body: note.body,
        status: "ready",
        createdAt: i + 1,
        actions: [],
        ...(width ? { width } : {}),
      });
    }
  } finally {
    db.close();
  }
}
