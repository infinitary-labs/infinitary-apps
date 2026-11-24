import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";

type Input = { deviceId: string };

/** One idle task on this computer and one placed on another computer, so the stage draws that computer's cluster and its name. */
export default function seed(userDataDir: string, { deviceId }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    for (const [id, placed] of [
      ["home-crew", undefined],
      ["mini-crew", deviceId],
    ] as const) {
      const worktreeDir = join(userDataDir, "crew", id);
      mkdirSync(worktreeDir, { recursive: true });
      seedTask(tasks, {
        id,
        title: `Crew ${id}`,
        status: "idle",
        worktreeDir,
        deviceId: placed,
        sessionFile: placed ? `placed-${id}.jsonl` : undefined,
        outcome: "Waiting for the captain.",
      });
    }
  } finally {
    db.close();
  }
}
