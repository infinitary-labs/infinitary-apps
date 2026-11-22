import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { SCRATCH_PROJECT_KEY } from "../../../src/core/storage/projectStore";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-key-late-scroll";
const TASK_ID = "key-late-scroll";

/** The one task's key: the first a fresh home numbers, in the project of tasks no project holds. */
const KEY = `${SCRATCH_PROJECT_KEY}-1`;

/**
 * The card's thread, read when it shows; the body's task key, which the
 * window looks up when it draws the key before it has read the board; and
 * the task's record, which the key's summary reads.
 */
export const asked: HomeRead[] = [
  ["inf:cards:thread", [CARD_ID]],
  ["inf:tasks:keys", [[KEY]]],
  ["inf:tasks:detail", [TASK_ID]],
];

/** What the card-key-late-scroll test's story reads back: the card's title. */
type Input = { title: string };

/**
 * A task waiting for the captain's word to start, and the first mate's card
 * naming it by its key at the top of a body too long for the card, with a
 * note to write at the end: the keyboard comes back up from the note to the
 * key, and the body scrolls to bring the key into view.
 */
export default function seed(userDataDir: string, { title }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: TASK_ID,
      title: "Prepare the launch checklist",
      status: "queued",
      startPolicy: "on-request",
    });
    if (task.key !== KEY) throw new Error(`The seeded task took ${task.key}, not ${KEY}`);
    new CardStore(db).upsert({
      id: CARD_ID,
      title,
      author: "firstmate",
      meta: "firstmate",
      priority: 20,
      body:
        `<p>The checklist in ${task.key} is ready. Pick when the launch goes out.</p>` +
        "<p>The rest of the plan follows, one step a line.</p>".repeat(24) +
        `<p><label>Note <textarea name="note"></textarea></label></p>`,
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "hold", label: "Hold", variant: "secondary" },
        { id: "launch", label: "Launch it", variant: "primary", default: true },
      ],
    });
  } finally {
    db.close();
  }
}
