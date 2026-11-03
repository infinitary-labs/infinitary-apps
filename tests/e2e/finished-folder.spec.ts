import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { latestServedTurn } from "./providerRequest";
import { expectRecordTaskStatus, nowFrame, pressRow, recordBar, recordFrame } from "./rails";
import {
  FINISH_FOLDER_PROMPT,
  FOLDER_CHECK_EVIDENCE,
  finishedFolder,
  MISSING_FOLDER_PROOF_PROMPT,
} from "./scenarios/finishedFolder";
import { pressKey } from "./windowKeys";

/**
 * INF-1279: verified folder work is done, not discarded, without changing
 * pre-existing edits, staged work, stashes or an unpushed commit.
 * The first mate's judgment is scripted; its tool, task owner, saved record,
 * task list and git readings are real. No accounts or shared data are used.
 */
test("verified folder work finishes through its owner and preserves the project", async () => {
  const userDataDir = scratchDir("infinitary-finished-folder-");
  const repoDir = join(userDataDir, "project");
  const origin = join(userDataDir, "origin.git");
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-optional-locks", ...args], { stdio: "pipe" }).toString();
  const run = (...args: string[]) => git("-C", repoDir, ...args);
  git("init", "--bare", "--initial-branch=main", origin);
  git("init", "--initial-branch=main", repoDir);
  run("config", "user.name", "Test");
  run("config", "user.email", "test@localhost");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "draft.txt"), "The captain’s existing draft.\n");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "notes.txt"), "Existing notes.\n");
  run("add", ".");
  run("commit", "-m", "docs: keep existing draft");
  run("remote", "add", "origin", origin);
  run("push", "-u", "origin", "main");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "notes.txt"), "Notes set aside for later.\n");
  run("stash", "push", "-m", "Keep the captain’s notes");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "local.txt"), "Work not pushed yet.\n");
  run("add", "local.txt");
  run("commit", "-m", "docs: retain unpushed work");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "draft.txt"), "The captain’s staged edits.\n");
  run("add", "draft.txt");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "draft.txt"), "The captain’s unfinished edits.\n");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "scratch.txt"), "The captain’s untracked notes.\n");
  const snapshot = () => ({
    files: ["draft.txt", "notes.txt", "local.txt", "scratch.txt"].map((file) => [
      file,
      readFileSync(join(repoDir, file), "utf8"),
    ]),
    status: run("status", "--porcelain=v1", "-z"),
    head: run("rev-parse", "HEAD"),
    refs: run("show-ref"),
    staged: run("diff", "--cached", "--binary"),
    edits: run("diff", "--binary"),
    stash: run("stash", "list"),
    reflog: run("reflog", "--all"),
    config: run("config", "--local", "--list"),
    unpushed: run("rev-list", "--count", "origin/main..HEAD").trim(),
  });
  const before = snapshot();
  expect(before.unpushed).toBe("1");
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, delivery, autonomy) VALUES (?, ?, ?, ?, 'init', 'local-only', 0)",
  ).run("folder-repo", repoDir, "Project", Date.now());
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "folderwork",
    title: "Check the project folder",
    status: "idle",
    outcome: FOLDER_CHECK_EVIDENCE,
    repoId: "folder-repo",
    repoDir,
    worktreeDir: "",
    branch: "",
    shape: {
      kind: "chore",
      kind_source: "test",
      deliverable: "change",
      in_place: { folder: true },
    },
  });
  db.close();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [finishedFolder],
  });
  try {
    const { page, mockProvider } = launched;
    const detail = () => page.evaluate(() => window.infinitary.tasks.detail("folderwork"));
    // Idle and reported alone is not proof. The first mate must declare its verification.
    await promptInput(page).fill(`${MISSING_FOLDER_PROOF_PROMPT}${task.title}`);
    await pressKey(promptInput(page), "Enter");
    await expect
      .poll(() =>
        mockProvider
          ?.requestBodies()
          .some((body) => (latestServedTurn(body)?.toolResults.length ?? 0) > 0),
      )
      .toBe(true);
    await expect.poll(detail).toMatchObject({ status: "active" });
    expect(snapshot()).toEqual(before);
    await promptInput(page).fill(`${FINISH_FOLDER_PROMPT}${task.title}`);
    await pressKey(promptInput(page), "Enter");
    await expect.poll(detail).toMatchObject({ status: "done", closedReason: "finished" });
    expect(snapshot()).toEqual(before);
    const done = nowFrame(page).locator('[data-now-group-header="landed"]');
    await expect(done).toBeVisible();
    await done.evaluate((element) => (element as HTMLElement).click());
    await pressRow(page, task.key);
    await expect(recordFrame(page).locator("[data-record-content]")).toBeVisible();
    await expectRecordTaskStatus(page);
    await expect(recordBar(page)).toHaveCount(0);
    // Product readings, not only a pass/fail line: the proof keeps the close and unchanged git state.
    writeFileSync(
      test.info().outputPath("folder-completion.json"),
      JSON.stringify({ record: await detail(), before, after: snapshot() }, null, 2),
    );
  } finally {
    await launched.close();
  }
});
