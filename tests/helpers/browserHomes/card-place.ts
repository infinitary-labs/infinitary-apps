import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-place-readme-1";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

type Words = { title: string; place: string; card: string };

/** A queued task placed on another computer, and its ready card naming where it runs. */
export default function seed(userDataDir: string, { title, place, card }: Words): void {
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "place-readme",
      title,
      status: "queued",
      startPolicy: "on-request",
      deviceId: "mini",
    });
    new CardStore(db).upsert({
      id: CARD_ID,
      taskId: task.id,
      author: "crewmate",
      priority: 15,
      title: card,
      meta: title,
      model: "Mock Model",
      place,
      body: "<p>The first line is Hello World. I changed nothing.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [],
    });
  } finally {
    db.close();
  }
}
