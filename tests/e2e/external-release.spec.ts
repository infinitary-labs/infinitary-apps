import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { nowFrame, pressRow, recordFrame } from "./rails";
import { externalRelease, RELEASE_PROMPT_MARKER } from "./scenarios/externalRelease";
import { shownCard } from "./stack";

/** The crewmate's note the spec seeds on the stage, and finds there. */
const RELEASE_NOTE_TITLE = "The release was published";

test("a verified external release closes reported work, not a dismissed note or unlanded work", async () => {
  const userDataDir = scratchDir("infinitary-release-settle-");
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = "fm/task-released";
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // The release is committed on main by a separate process, not on this task's branch.
  writeFileSync(join(repoDir, "release.txt"), "published v1.2.3\n");
  git("-C", repoDir, "add", "release.txt");
  git("-C", repoDir, "commit", "-m", "release: v1.2.3");
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo-release", repoDir, "r", Date.now(), "https://github.com/o/r.git");
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "released",
    title: "Publish the build",
    status: "idle",
    outcome: "Release-please published v1.2.3; checked its artifact.",
    repoId: "repo-release",
    repoDir,
    worktreeDir,
    branch,
  });
  new CardStore(db).upsert({
    id: "card-released-note",
    taskId: "released",
    author: "crewmate",
    priority: 30,
    title: RELEASE_NOTE_TITLE,
    meta: "crewmate 1",
    body: "<p>Version v1.2.3 is available.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  });
  db.close();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [externalRelease],
  });
  try {
    const { page, mockProvider } = launched;
    await expect(shownCard(page, RELEASE_NOTE_TITLE)).toBeVisible();
    // A note disappearing and a missing task-owned change are not a close.
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.tasks.detail("released")))
      .toMatchObject({ status: "active" });

    writeFileSync(join(worktreeDir, "pending.txt"), "not released\n");
    const input = promptInput(page);
    await input.fill(`${RELEASE_PROMPT_MARKER}Publish the build`);
    await input.press("Enter");
    await expect
      .poll(
        () => mockProvider?.requestBodies().some((body) => body.includes("uncommitted edits")),
        {
          timeout: 30_000,
        },
      )
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.infinitary.tasks.detail("released")))
      .toMatchObject({ status: "active" });
    expect(existsSync(worktreeDir)).toBe(true);

    // Resolve the unlanded edit, then the same explicit declaration can close.
    git("-C", worktreeDir, "clean", "-f", "pending.txt");
    await input.fill(`${RELEASE_PROMPT_MARKER}Publish the build`);
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.infinitary.tasks.detail("released")))
      .toMatchObject({ status: "done", closedReason: "released" });
    await expect.poll(() => existsSync(worktreeDir)).toBe(false);
    await page.getByRole("button", { name: "Expand Tasks" }).click();
    const done = nowFrame(page).locator('[data-now-group-header="landed"]');
    await expect(done).toBeVisible();
    await done.evaluate((el) => (el as HTMLElement).click());
    const row = nowFrame(page).locator('[data-now-group="landed"] [data-now-row]');
    await expect(row).toHaveCount(1);
    await pressRow(page, (await row.getAttribute("data-now-key")) ?? "");
    await expect(recordFrame(page).getByText(/Released/)).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("external-release-done.png"),
      animations: "disabled",
    });
    expect(git("-C", repoDir, "log", "-1", "--format=%s", "main").trim()).toBe("release: v1.2.3");
  } finally {
    await launched.close();
  }
});
