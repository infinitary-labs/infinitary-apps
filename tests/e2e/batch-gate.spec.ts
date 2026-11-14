import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { armWatch } from "../../src/core/orchestrator/checkWatch";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { ROW_WORDS } from "../../src/panels/now/words";
import { BATCH_CHECK, BATCH_STATUS_WORDS, BATCH_WAITING_WORDS } from "../../src/shared/batches";
import { taskStatusLabel, taskStatusOf } from "../../src/shared/taskPresentation";
import { workPostureLabel } from "../../src/shared/workPosture";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { emberRing } from "./crew";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { expandDock, nowRow, nowRowGroup, rowSummary } from "./rails";
import { minimizeForLegacyView } from "./stack";
import { focusOn } from "./windowKeys";

const BLOCKER = "The map needs a review before publication.";
const CHECKS = "The pull request checks are still running.";

function fixture(): string {
  const userDataDir = scratchDir("infinitary-wait-reason-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const cards = new CardStore(db);
  for (const [id, title, text] of [
    ["blocked", "Open the harbour map pull request", BLOCKER],
    ["checks", "Check the harbour map", CHECKS],
    ["batch-waiting", "Publish the harbour map", CHECKS],
    ["batch-running", "Publish the coast map", CHECKS],
    ["batch-paused", "Publish the bay map", CHECKS],
    ["choice", "Choose the harbour map", "The map is ready for your review."],
  ] as const) {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, { id, title, status: "idle", worktreeDir });
    tasks.turns.recordReport(id, { text, summary: text, declared: { wait: { reason: text } } });
    tasks.placement.setGate(id, { kind: "captain" });
  }
  // The durable watch reads a real head; no forge request is due during this journey.
  for (const id of ["checks", "batch-waiting", "batch-running", "batch-paused"]) {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: join(userDataDir, "worktrees", id),
        env: hostEnv({ HOME: userDataDir, GIT_CONFIG_GLOBAL: "/dev/null" }),
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    git("init", "--initial-branch=main");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "chore: seed checks",
    );
    const head = git("rev-parse", "HEAD");
    seedDelivery(tasks, id, {
      mode: "direct-pr",
      prNumber: 57,
      headSha: head,
      ci: "pending",
      ciWatch: armWatch(undefined, head, Date.now()),
      ...(id !== "checks"
        ? {
            checks: {
              headSha: head,
              items: [{ name: BATCH_CHECK, state: "pending" as const }],
              absenceDeclared: false,
            },
            // The place the person's own batch keeps on each change (`batchStatus`, `src/core/batches/line.ts`).
            queueStatus:
              id === "batch-running"
                ? { head, kind: "in-batch" as const, words: BATCH_STATUS_WORDS.batch }
                : id === "batch-paused"
                  ? { head, kind: "paused" as const, words: BATCH_STATUS_WORDS.held("checks") }
                  : { head, kind: "waiting" as const, words: BATCH_WAITING_WORDS },
          }
        : {}),
    });
  }
  const note = {
    id: "past-note",
    taskId: "blocked",
    author: "firstmate" as const,
    title: "The work is paused",
    meta: "firstmate",
    body: "<p>The crewmate stopped.</p>",
    actions: [],
    priority: 0,
    status: "ready" as const,
    createdAt: Date.now(),
  };
  cards.upsert(note);
  cards.resolve(note.id, "dismissed");
  tasks.capture.recordCardResolved("blocked", {
    cardId: note.id,
    title: note.title,
    action: "dismissed",
  });
  cards.upsert({
    id: "real-choice",
    taskId: "choice",
    author: "firstmate",
    title: "Which map should we use?",
    meta: "firstmate",
    body: "<p>Choose the map.</p>",
    priority: 0,
    actions: [
      { id: "harbour", label: "Harbour map" },
      { id: "bay", label: "Bay map" },
    ],
    status: "ready",
    createdAt: Date.now(),
  });
  db.close();
  return userDataDir;
}

/** Approved batch gate: a pending batch and an own-checks wait must look different.
 * Real git versions, task/delivery writers and the private app; no external forge or account.
 * Completion: persisted posture, the Tasks marks/words/groups and keyboard summary agree; the stage paints cool waits.
 */
test("batch waiting, running and paused stay distinct from own checks in the stage and Tasks", async () => {
  const app = await launchApp({ userDataDir: fixture(), withMockProvider: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1280, height: 800 });
    await minimizeForLegacyView(page, "Which map should we use?");
    await expandDock(page, "now");
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    for (const [id, batch] of [
      ["batch-waiting", "waiting"],
      ["batch-running", "in-batch"],
      ["batch-paused", "paused"],
    ] as const) {
      const task = board.tasks.find((row) => row.id === id);
      if (!task?.workPosture) throw new Error(`Missing batch fixture ${id}`);
      expect(task.workPosture).toEqual({ state: "active", reason: "checks", batch });
      const row = nowRow(page, task.key);
      await expect(row.locator("[data-task-mark]")).toHaveAttribute("data-task-wait", "batch");
      await expect(row.locator("[data-now-word]")).toHaveText(` · ${ROW_WORDS.batch}`);
      expect(await nowRowGroup(page, task.key)).toBe("working");
      await focusOn(row);
      await expect(rowSummary(page).locator("[data-task-fact=status]")).toHaveText(
        taskStatusLabel(taskStatusOf(task)),
      );
      expect(taskStatusOf(task).reason).toBe(workPostureLabel(task.workPosture));
    }
    const checks = board.tasks.find((row) => row.id === "checks");
    if (!checks) throw new Error("Missing own checks fixture");
    await expect(nowRow(page, checks.key).locator("[data-task-mark]")).toHaveAttribute(
      "data-task-wait",
      "checks",
    );
    await expect(nowRow(page, checks.key).locator("[data-now-word]")).toHaveText(
      ` · ${ROW_WORDS.checks}`,
    );
    expect((await emberRing(page)).ember).toBe(0);
    await test.info().attach("batch and checks public task readings", {
      body: JSON.stringify(board, null, 2),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});
