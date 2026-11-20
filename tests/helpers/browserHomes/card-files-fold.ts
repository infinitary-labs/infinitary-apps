import { createHash } from "node:crypto";
import { cardFileId, cardFileStoredName } from "@shared/cardFiles";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-hero-shots";
const TASK_ID = "task-hero-shots";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/** What the card-files-fold test's story reads back. */
type Input = {
  title: string;
  taskTitle: string;
  paragraph: string;
  files: { name: string; bytes: number }[];
};

/**
 * The note from the captain's picture (INF-4427): a crewmate re-recorded
 * the landing page's hero shots and put all sixteen recordings and posters
 * on its card, by their names and sizes in that picture. The card keeps
 * only references; nothing here saves a file.
 */
export default function seed(userDataDir: string, input: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, { id: TASK_ID, title: input.taskTitle, status: "idle" });
    new CardStore(db).upsert({
      id: CARD_ID,
      taskId: TASK_ID,
      author: "crewmate",
      meta: "crewmate",
      priority: 30,
      title: input.title,
      body: `<p>${input.paragraph}</p>`.repeat(4),
      status: "ready",
      createdAt: Date.now(),
      actions: [],
      files: input.files.map(({ name, bytes }) => {
        const sha256 = createHash("sha256").update(name).digest("hex");
        const id = cardFileId(TASK_ID, sha256);
        return { id, name, bytes, sha256, path: `/kept/${cardFileStoredName(id)}` };
      }),
    });
  } finally {
    db.close();
  }
}
