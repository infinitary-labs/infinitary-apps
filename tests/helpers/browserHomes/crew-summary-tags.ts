import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import { seedProject } from "../../../src/core/workspace/seedProject";
import type { HomeRead } from "../browserFreshHome";

type Input = { tags: readonly string[] };

const CREW = "summary-tags-crew";

/** The crewmate's task record, read when the pointer opens its summary. */
export const asked: HomeRead[] = [["inf:tasks:detail", [CREW]]];

/**
 * One idle crewmate on this computer, in a project kept on this computer
 * that has `tags` as its own tags, every one of them on the crewmate's
 * task, set through the core's own tag writer as a person's Edit tags sets
 * them.
 */
export default function seed(userDataDir: string, { tags }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    seedProject(db, {
      id: "repo-harbour",
      name: "harbour",
      path: join(userDataDir, "harbour"),
      setupKind: "init",
      runsOn: null,
      key: "HAR",
    });
    const tasks = new TaskService({ db, strict: true });
    // A real idle task has a workspace, or boot starts it again.
    const worktreeDir = join(userDataDir, "crew", CREW);
    mkdirSync(worktreeDir, { recursive: true });
    const task = seedTask(tasks, {
      id: CREW,
      repoId: "repo-harbour",
      title: "Match approved raw-SQL calls by function, not line",
      status: "idle",
      worktreeDir,
      outcome: "Fixture crew is waiting for the captain.",
    });
    for (const name of tags)
      tasks.changeProjectTags({
        op: "add",
        projectId: task.projectId,
        name,
        description: `Tasks about ${name}.`,
      });
    tasks.replaceTags(CREW, { names: tags }, "captain");
  } finally {
    db.close();
  }
}
