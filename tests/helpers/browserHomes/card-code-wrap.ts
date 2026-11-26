import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-code-wrap";

export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

type Words = { title: string; body: string };

/** A crewmate note whose body is the given HTML, drawn in the card frame. */
export default function seed(userDataDir: string, { title, body }: Words): void {
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "code-wrap",
      title: "Find the commands to update a server",
      status: "queued",
      startPolicy: "on-request",
    });
    new CardStore(db).upsert({
      id: CARD_ID,
      taskId: task.id,
      author: "crewmate",
      meta: "crewmate",
      priority: 15,
      title,
      body,
      status: "ready",
      createdAt: Date.now(),
      actions: [],
    });
  } finally {
    db.close();
  }
}
