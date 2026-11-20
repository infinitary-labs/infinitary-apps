import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { keptRefFor } from "../../src/core/workspace/workspaceService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { nowFrame, pressRow, recordCard } from "./rails";
import { externalRelease, RELEASE_PROMPT_MARKER } from "./scenarios/externalRelease";
import { noteDone, shownCard } from "./stack";
import { runFromSearch } from "./windowKeys";

/** The crewmate's note the spec seeds on the stage, and finds there. */
const RELEASE_NOTE_TITLE = "The release was published";

test("a verified external release closes reported work, not a dismissed note, and saves its unlanded edit", async () => {
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
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "release.txt"), "published v1.2.3\n");
  git("-C", repoDir, "add", "release.txt");
  git("-C", repoDir, "commit", "-m", "release: v1.2.3");
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-release",
    path: repoDir,
    name: "r",
    setupKind: "clone",
    origin: "https://github.com/o/r.git",
    runsOn: null,
    delivery: "direct-pr",
  });
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
    await noteDone(page).first().click();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.tasks.detail("released")))
      .toMatchObject({ status: "active" });

    // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
    writeFileSync(join(worktreeDir, "pending.txt"), "not released\n");
    // The release names where the work went, so an uncommitted edit no longer
    // holds the close: the close saves it and says so (one close as done).
    const input = promptInput(page);
    await input.fill(`${RELEASE_PROMPT_MARKER}Publish the build`);
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.infinitary.tasks.detail("released")))
      .toMatchObject({ status: "done", closedReason: "released" });
    await expect
      .poll(() =>
        mockProvider?.requestBodies().some((body) => body.includes("uncommitted edits, saved")),
      )
      .toBe(true);
    await expect.poll(() => existsSync(worktreeDir)).toBe(false);
    // The saved edit is on the task's kept ref.
    expect(git("-C", repoDir, "show", `${keptRefFor("released")}:pending.txt`)).toBe(
      "not released\n",
    );
    await page.getByRole("button", { name: "Expand Tasks" }).click();
    const done = nowFrame(page).locator('[data-now-group-header="landed"]');
    await expect(done).toBeVisible();
    await done.evaluate((el) => (el as HTMLElement).click());
    const row = nowFrame(page).locator('[data-now-group="landed"] [data-now-row]');
    await expect(row).toHaveCount(1);
    await pressRow(page, (await row.getAttribute("data-now-key")) ?? "");
    // The row shows the completion note; the record remains available through Show Info.
    await runFromSearch(launched.app, page, "cards.show-info");
    // The closed line leads the Info tab in the card itself (INF-2261).
    await expect(recordCard(page).getByText(/Released/)).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("external-release-done.png"),
      animations: "disabled",
    });
    expect(git("-C", repoDir, "log", "-1", "--format=%s", "main").trim()).toBe("release: v1.2.3");
  } finally {
    await launched.close();
  }
});
