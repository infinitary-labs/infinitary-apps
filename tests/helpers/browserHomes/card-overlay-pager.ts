import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

type Input = { titles: string[]; paragraphs: number[] };

/** The most cards the test stacks. */
const MOST = 3;

/** Each card's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:cards:thread",
  [`overlay-${i + 1}`],
]);

/** Ordinary unseen notes from the first mate, the first on top, so the pager and its new badge show; each body runs its count of paragraphs. */
export default function seed(userDataDir: string, { titles, paragraphs }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    titles.forEach((title, i) =>
      cards.upsert({
        id: `overlay-${i + 1}`,
        author: "firstmate",
        meta: "firstmate",
        priority: 50,
        title,
        body: Array.from(
          { length: paragraphs[i] ?? 1 },
          (_, p) => `<p>Card ${i + 1}, paragraph ${p + 1} of the overlay's stack.</p>`,
        ).join(""),
        status: "ready",
        createdAt: i + 1,
        actions: [],
      }),
    );
  } finally {
    db.close();
  }
}
