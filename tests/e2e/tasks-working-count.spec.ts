import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { ensureRepoProject } from "../../src/core/storage/projectStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { nowGroupOf } from "../../src/shared/nowPanel";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { seedHostedOrigins } from "./projectSeed";
import { dockSummaryParts, expandDock, nowFrame } from "./rails";

// Exact count arithmetic belongs to the Tasks folder's rows.test.ts. This
// journey checks that the own-state count reaches the header the panel
// says while collapsed, while the tree remains visible.
test("Tasks counts working tasks without counting their contextual tree", async () => {
  const userDataDir = scratchDir("infinitary-working-count-");
  const repo = join(userDataDir, "project");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", repo);
  git("-C", repo, "config", "user.name", "Test");
  git("-C", repo, "config", "user.email", "test@localhost");
  git("-C", repo, "commit", "--allow-empty", "-m", "init");
  const db = openDatabase(userDataDir);
  const now = Date.now();
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo", repo, "Sample project", now, "https://github.com/o/sample.git");
  seedHostedOrigins(db, userDataDir);
  ensureRepoProject(db, { id: "repo", name: "Sample project" }, now, "FM3K");
  const tasks = new TaskService({ db, strict: true, now: () => now });
  const seed = (value: Parameters<typeof seedTask>[1]) =>
    seedTask(tasks, { repoId: "repo", ...value });
  seed({
    id: "parent",
    title: "Improve project setup",
    status: "queued",
    startPolicy: "on-request",
  });
  const worktreeDir = join(userDataDir, "worktrees", "child");
  mkdirSync(worktreeDir, { recursive: true });
  seed({
    id: "child",
    parentId: "parent",
    title: "Simplify setup",
    status: "completed",
    worktreeDir,
  });
  seed({
    id: "queued",
    parentId: "parent",
    title: "Review setup",
    status: "queued",
    gate: { kind: "at-time", until: now + 30 * 24 * 60 * 60_000 },
  });
  seed({
    id: "done",
    parentId: "parent",
    title: "Document setup",
    status: "queued",
    startPolicy: "on-request",
  });
  tasks.close("done", { status: "done", reason: "finished", actor: "host" });
  db.close();
  const { app, page } = await launchApp({ userDataDir, withMockProvider: true });
  try {
    await resizeWindow(app, page, { width: 1280, height: 800 });
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(4);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const panel = page.locator('[data-side-panel="now"]');
    await expect(panel).toBeVisible();
    console.log(
      "Working count evidence",
      JSON.stringify({
        tasks: board.tasks.map(({ key, status, activity }) => ({ key, status, activity })),
        header: await panel.innerText(),
      }),
    );
    await panel.screenshot({ path: test.info().outputPath("collapsed-header.png") });
    // Read the calculation through the shared owner of a task's own state.
    const working = board.tasks.filter((task) => nowGroupOf(task) === "working").length;
    expect(working).toBe(1);
    // The panel says waiting, then working, as the parts of its collapsed header.
    await expect
      .poll(async () => (await dockSummaryParts(page, "now"))[1])
      .toMatch(new RegExp(`^${working}\\b`));
    await expandDock(page, "now");
    await expect(nowFrame(page).locator('[data-now-group="working"] [data-now-row]')).toHaveCount(
      4,
    );
    await panel.screenshot({ path: test.info().outputPath("expanded-tree.png") });
  } finally {
    await app.close();
  }
});
