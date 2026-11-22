import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import { seedHostedOrigins, seedProject } from "../../e2e/projectSeed";
import type { HomeRead } from "../browserFreshHome";

/** A hosted project at a fixed id its tasks name. */
type Project = { repoId: string; name: string; key: string };

type Work = { id: string; title: string; repoId: string };

type Input = { projects: Project[]; work: Work[]; waitsOn: string[] };

/** The window sends no read with arguments for this home. */
export const asked: HomeRead[] = [];

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/**
 * Hosted projects, each with finished crewmates kept on the stage, and a step
 * only the captain can take, set aside, on each task of `waitsOn`.
 */
export default function seed(userDataDir: string, { projects, work, waitsOn }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const now = Date.now();
    for (const project of projects)
      seedProject(db, {
        id: project.repoId,
        path: repo(join(userDataDir, project.name)),
        name: project.name,
        setupKind: "clone",
        origin: `https://github.com/o/${project.name}.git`,
        runsOn: null,
        delivery: "direct-pr",
        addedAt: now,
        key: project.key,
      });
    seedHostedOrigins(db, userDataDir);
    const tasks = new TaskService({ db, strict: true });
    for (const task of work) {
      const worktreeDir = join(userDataDir, "worktrees", task.id);
      mkdirSync(worktreeDir, { recursive: true });
      // A crewmate that finished and went idle: on the stage, with its model's name.
      seedTask(tasks, {
        ...task,
        status: "completed",
        worktreeDir,
        model: { provider: "fm-mock", id: "mock-1" },
      });
    }
    // A step only the captain can take, set aside: its row waits on the captain.
    for (const source of waitsOn)
      tasks.delivery.declareRequiredActions(
        source,
        {
          cardId: `card-${source}`,
          offerId: `offer-${source}`,
          actions: [
            {
              id: "install",
              target: "the Mac mini",
              title: "Install the new version on the Mac mini",
              consequence: "Until then the Mac mini keeps the old version.",
              instructions: ["Open Infinitary on the Mac mini."],
              criterion: "The Mac mini reports the new version.",
              prerequisites: [],
              completion: { kind: "manual", label: "I installed it" },
            },
          ],
        },
        true,
      );
    for (const row of tasks.listOpen().filter((r) => r.delivery?.captainAction)) {
      tasks.delivery.presentCaptainAction(row.id);
      tasks.delivery.deferCaptainAction(row.id);
    }
  } finally {
    db.close();
  }
}
