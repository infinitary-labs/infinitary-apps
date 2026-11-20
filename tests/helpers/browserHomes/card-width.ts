import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { decidedCardWidth } from "../../../src/core/pi/cardWidth";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

/** One note the crewmate shows: its words, and the author's width hint if it gave one. */
type Shown = { title: string; body: string; width?: "wide" | "full" };

/** What the card-width test's story reads back: the crewmate's notes, in the order it showed them. */
type Input = { notes: Shown[] };

/** The most notes the crewmate shows. */
const MOST = 4;

/** Each note's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:cards:thread",
  [`width-${i + 1}`],
]);

/**
 * A crewmate holding for the captain under the notes it showed in one turn,
 * each as wide as the host decides at emit (`decidedCardWidth`): from the
 * body's own facts, widened by the author's hint.
 */
export default function seed(userDataDir: string, { notes }: Input): void {
  if (notes.length > MOST) throw new Error(`The seed shows at most ${MOST} notes`);
  const db = openDatabase(userDataDir);
  try {
    // A real idle task has a working copy; without one, boot starts it again.
    const worktreeDir = join(userDataDir, "crew", "widths");
    mkdirSync(worktreeDir, { recursive: true });
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "widths-task",
      title: "Show the card widths",
      status: "idle",
      worktreeDir,
      outcome: "The notes are up.",
    });
    const store = new CardStore(db);
    for (const [index, note] of notes.entries()) {
      const width = decidedCardWidth(note);
      store.upsert({
        id: `width-${index + 1}`,
        taskId: task.id,
        author: "crewmate",
        priority: 15,
        title: note.title,
        meta: task.title,
        model: "Mock Model",
        body: note.body,
        status: "ready",
        createdAt: Date.now() + index,
        actions: [],
        ...(width ? { width } : {}),
      });
    }
  } finally {
    db.close();
  }
}
