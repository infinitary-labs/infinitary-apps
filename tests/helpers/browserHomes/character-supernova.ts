import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";

type Input = { crew: number };

export default function seed(userDataDir: string, { crew }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    for (let i = 0; i < crew; i++) {
      // A real idle task has a workspace, or boot starts it again.
      const worktreeDir = join(userDataDir, "crew", String(i));
      mkdirSync(worktreeDir, { recursive: true });
      seedTask(tasks, {
        id: `supernova-crew-${i}`,
        title: `Supernova crew ${i}`,
        status: "idle",
        worktreeDir,
        outcome: "Fixture crew is waiting for the captain.",
        createdAt: Date.now() + i,
      });
    }
  } finally {
    db.close();
  }
}
