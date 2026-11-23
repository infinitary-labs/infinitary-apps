import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

type Note = { id: string; title: string; body: string };

type Input = { notes: Note[] };

/** Each card's thread, empty, read as the card shows. */
export const asked: HomeRead[] = [
  ["inf:cards:thread", ["short"]],
  ["inf:cards:thread", ["tall"]],
  ["inf:cards:thread", ["later"]],
];

/** The first mate's notes on the stack, filed a moment apart in the order given. */
export default function seed(userDataDir: string, { notes }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const store = new CardStore(db);
    for (const [at, { id, title, body }] of notes.entries())
      store.upsert({
        id,
        author: "firstmate",
        meta: "firstmate",
        priority: 25,
        title,
        body,
        actions: [],
        status: "ready",
        createdAt: 1000 + at,
      });
  } finally {
    db.close();
  }
}
