import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

type Input = { cardId: string; title: string };

/** The card's thread, empty until the captain replies, read when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", ["thread-card"]]];

/** A crewmate holding for the captain under its own decision card. */
export default function seed(userDataDir: string, { cardId, title }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    // A real idle task has a working copy; without one, boot starts it again.
    const worktreeDir = join(userDataDir, "crew", "thread");
    mkdirSync(worktreeDir, { recursive: true });
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "thread-task",
      title: "Fix the flaky test",
      status: "idle",
      worktreeDir,
      outcome: "The card is up and I am holding for the captain.",
    });
    new CardStore(db).upsert({
      id: cardId,
      taskId: task.id,
      author: "crewmate",
      priority: 15,
      title,
      meta: task.title,
      model: "Mock Model",
      body: "<p>Awaiting the job queue removes the race entirely.</p><p>Mocking the clock is quicker but leaves write order uncertain.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "mock-clock", label: "Mock the clock" },
        { id: "await-queue", label: "Await the queue", default: true },
      ],
    });
  } finally {
    db.close();
  }
}
