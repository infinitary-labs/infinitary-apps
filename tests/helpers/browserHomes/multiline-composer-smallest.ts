import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

/** What the multiline-composer-smallest test's story reads back. */
type Input = { cardId: string; title: string; ask: string };

/** The card's thread, empty, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", ["fm-thread-card"]]];

/**
 * The first mate's own card with two ways to choose, raised for the
 * captain's last message, which the last turn above the input shows with
 * the card's title as its reply line.
 */
export default function seed(userDataDir: string, { cardId, title, ask }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    tasks.openAsk({ id: "ask-thread", text: ask });
    tasks.setAskReply("ask-thread", { text: title });
    tasks.closeAsk("ask-thread", "closed");
    new CardStore(db).upsert({
      id: cardId,
      author: "firstmate",
      meta: "firstmate",
      priority: 50,
      title,
      body: '<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "chips-first", label: "Lead with the chips" },
        { id: "caption-first", label: "Lead with the caption", default: true },
      ],
    });
  } finally {
    db.close();
  }
}
