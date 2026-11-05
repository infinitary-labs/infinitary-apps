import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { recordAttentionWaits, taskWaitSummary, taskWaitText } from "../../src/shared/taskWaits";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { overflows } from "./layout";
import { regionShot } from "./pictures";
import { expandDock, expectRecordBody, nowFrame, nowRow, recordCard } from "./rails";
import { boardTile, openBoardButton } from "./taskBoard";
import { focusOn, pressKey } from "./windowKeys";

/** Nightly product audit finding 4: read what a task waits for without asking why it has not started.
 * Real task records, graph links and local timestamps; the model is the launcher's offline stand-in.
 * INF-2215 retains the Tasks line, groups board waits and reconciles full dates into the record.
 * Completion is the prerequisite on every surface, with recorded dates in full detail, reached by keyboard.
 * The hermetic desktop launcher owns the only shared resource, its windowless Electron process.
 */
test("a queued task names its prerequisite and time on every task surface", async () => {
  const userDataDir = scratchDir("infinitary-queue-wait-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, repos: { get: () => undefined } });
  const plan = seedTask(tasks, {
    id: "plan",
    title: "Review the project plan",
    status: "queued",
    startPolicy: "on-request",
  });
  const build = seedTask(tasks, {
    id: "build",
    title: "Build the approved project",
    status: "queued",
  });
  tasks.graph.link(plan.id, build.id, "blocks", "firstmate");
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { page } = launched;
  try {
    const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), build.id);
    const line = detail.queueWait?.line;
    expect(line).toContain(plan.key);
    expect(detail.queueWait?.since).toBeGreaterThanOrEqual(build.createdAt);
    expect(line).toBeTruthy();
    if (!line) throw new Error("The queued task has no start-wait fact");
    await expandDock(page, "now");
    await expect(nowRow(page, build.key).locator("[data-now-queue-wait]")).toHaveText(line);
    const backlog = nowFrame(page).locator('[data-now-group-header="backlog"]');
    await focusOn(backlog);
    await pressKey(backlog, "Enter");
    const planDetail = await page.evaluate((id) => window.infinitary.tasks.detail(id), plan.id);
    const go = planDetail.queueWait?.line;
    expect(go).toBeTruthy();
    // Captain's card review: Backlog stays compact; only Queued adds the wait line.
    await expect(nowRow(page, plan.key)).toBeVisible();
    await expect(nowRow(page, plan.key).locator("[data-now-queue-wait]")).toHaveCount(0);
    await expect(nowRow(page, build.key).locator("[data-now-queue-wait]")).toHaveText(line);
    if (test.info().repeatEachIndex === test.info().project.repeatEach - 1) {
      await regionShot(
        page.locator('[data-side-panel="now"]'),
        test.info().outputPath("queued-and-compact-backlog.png"),
      );
    }
    await focusOn(openBoardButton(page));
    await pressKey(openBoardButton(page), "Enter");
    for (const task of [detail, planDetail]) {
      const summary = taskWaitSummary(task.waits ?? [], Date.now());
      if (!summary) throw new Error("The queued task has no grouped wait facts");
      const tile = boardTile(page, task.key);
      const wait = tile.locator("[data-board-wait]");
      await expect(wait.getByText(` · ${summary.names}`, { exact: true })).toBeVisible();
      await expect(wait.getByText(summary.event, { exact: true })).toBeVisible();
      expect(await overflows(tile.locator("[data-board-status]"))).toBe(0);
    }
    await focusOn(boardTile(page, build.key));
    await pressKey(boardTile(page, build.key), "Enter");
    await expectRecordBody(page);
    const waits = recordAttentionWaits(detail);
    expect(waits).toHaveLength(1);
    expect(waits[0]?.taskKeys).toEqual([plan.key]);
    expect(waits[0]?.since).toBe(detail.queueWait?.since);
    await expect(recordCard(page).locator("[data-record-attention-title]")).toHaveText(
      waits.map((wait) => taskWaitText(wait, Date.now())).join("; "),
    );
  } finally {
    await launched.close();
  }
});
