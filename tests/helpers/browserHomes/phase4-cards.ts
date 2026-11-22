import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CardAction } from "@shared/cards";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

type Shown = { title: string; body: string; actions: CardAction[] };

type Input = { cards: Shown[] };

const MOST = 3;

/** Each card's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:cards:thread",
  [`kinds-${i + 1}`],
]);

/**
 * A crewmate holding for the captain under the cards it showed in one turn:
 * a decision, a note and a decision whose body is a working preview, each
 * at the priority the core gives what it is - a decision before a note.
 */
export default function seed(userDataDir: string, { cards }: Input): void {
  if (cards.length > MOST) throw new Error(`The seed shows at most ${MOST} cards`);
  const db = openDatabase(userDataDir);
  try {
    // A real idle task has a working copy; without one, boot starts it again.
    const worktreeDir = join(userDataDir, "crew", "kinds");
    mkdirSync(worktreeDir, { recursive: true });
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "kinds-task",
      title: "Show every card kind",
      status: "idle",
      worktreeDir,
      outcome: "The cards are up and I am holding for the captain.",
    });
    const store = new CardStore(db);
    for (const [index, card] of cards.entries())
      store.upsert({
        id: `kinds-${index + 1}`,
        taskId: task.id,
        author: "crewmate",
        priority: card.actions.length > 0 ? 30 : 15,
        title: card.title,
        meta: task.title,
        model: "Mock Model",
        body: card.body,
        status: "ready",
        createdAt: Date.now() + index,
        actions: card.actions,
      });
  } finally {
    db.close();
  }
}
