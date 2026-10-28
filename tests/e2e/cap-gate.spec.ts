import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { launchApp } from "./launch";

// Accepted INF-1177 piece 0: historical count fields never hold current work.
// Real saved delivery and gate state, read through the board after a fresh launch.
test("legacy repair and review caps no longer hold work after launch", async () => {
  const userDataDir = scratchDir("infinitary-retired-caps-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  for (const id of ["ci-history", "review-history"]) {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, {
      id,
      title: id === "ci-history" ? "Read the project checks" : "Review the meter fix",
      status: "completed",
      worktreeDir,
      outcome: "The crewmate is reading the current evidence.",
    });
    seedDelivery(tasks, id, {
      headSha: "93355db9d04e964513879db74d068a7789cb4c16",
      ciRounds: 3,
      ciCapAt: Date.now(),
      reviewRounds: 3,
      reviewCapAt: Date.now(),
    });
    tasks.setGate(id, { kind: "captain", reason: "the CI cap" });
  }
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    for (const id of ["ci-history", "review-history"]) {
      await expect
        .poll(async () => {
          const board = await launched.page.evaluate(() => window.infinitary.tasks.board());
          return board.tasks.find((task) => task.id === id)?.flags;
        })
        .toMatchObject({ held: false, needsYou: false });
    }
    expect(await launched.page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
  } finally {
    await launched.close();
  }
});
