import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

/** What the crew-planes test's story holds: how many idle crew. */
type Input = { crew: number };

/** The most crew the test seeds. */
const MOST = 48;

/** The id of the `index`th crewmate's task. */
const crewId = (index: number) => `orbit-crew-${index}`;

/** Each crewmate's task record, read when the pointer opens its summary. */
export const asked: HomeRead[] = Array.from({ length: MOST }, (_, i) => [
  "inf:tasks:detail",
  [crewId(i)],
]);

/** Idle crew on this computer, each with its working copy. */
export default function seed(userDataDir: string, { crew }: Input): void {
  if (crew > MOST) throw new Error(`The crew-planes home reads at most ${MOST} crew`);
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    for (let i = 0; i < crew; i++) {
      // A real idle task has a workspace, or boot starts it again.
      const worktreeDir = join(userDataDir, "crew", String(i));
      mkdirSync(worktreeDir, { recursive: true });
      seedTask(tasks, {
        id: crewId(i),
        title: `Orbit crew ${i}`,
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
