import { expect, type Locator, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { waitRecordedTime } from "../../src/shared/taskPresentation";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { expectClearOf, resizeWindow, slidePointer } from "./layout";
import {
  activityFrame,
  atRest,
  dockRegion,
  expandDock,
  reportLine,
  restOnTaskKey,
  rowSummary,
  startedLine,
  taskKeyLinks,
} from "./rails";
import { pressKey } from "./windowKeys";

/** INF-1761 / approved INF-1759 A: full recorded words beside every line and the collapsed header.
 * Real TaskService records and feed reads; completion is the drawn summary and preserved key journey.
 * Hidden desktop, isolated HOME/data, no accounts or shared data. Pointer routing owns the desktop lane.
 */
async function restOnWords(page: Page, row: Locator) {
  await atRest(page, row);
  // The inline text's box extends beyond its clipped cell; rest on the visible cell.
  const box = await row.locator("[data-feed-line]").boundingBox();
  if (!box) throw new Error("The Activity line is not drawn");
  const at = { x: box.x + box.width - 2, y: box.y + box.height / 2 };
  await slidePointer(page, at, at, 1);
}

test("every Activity line reads in full beside the panel; keys and collapsed header keep their own focus", async () => {
  const userDataDir = scratchDir("infinitary-line-preview-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "release-notes",
    title: "Group the release notes by feature area",
    status: "idle",
    startPolicy: "on-request",
    outcome: "The release notes now group related changes so the next release is easier to review.",
  });
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true, gpuBenchmarking: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1280, height: 800 });
    await expandDock(page, "activity");
    const line = reportLine(page, task.key);
    await expect(line).toBeVisible();
    const recorded = (await page.evaluate(() => window.infinitary.feed.recent())).find(
      (line) => line.taskKey === task.key && line.event === "report",
    );
    if (!recorded) throw new Error("The task's report did not reach the feed");
    const summary = page.locator("[data-line-summary]:not([aria-hidden])");
    await restOnWords(page, line);
    await expect(summary.locator("[data-line-summary-text]")).toHaveText(recorded.text);
    await expect(summary.locator("time")).toHaveText(waitRecordedTime(recorded.at, Date.now()));
    await expect(summary.locator('[data-task-fact="task"]')).toHaveText(task.title);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const boardTask = board.tasks.find((row) => row.id === task.id);
    const project = board.projects.find((project) => project.id === boardTask?.projectId);
    if (!project) throw new Error("The task's project was not on the board");
    await expect(summary.locator('[data-task-fact="project"]')).toHaveText(project.name);
    await expect(taskKeyLinks(line)).toHaveAttribute("data-task-lit", "");
    await expectClearOf(
      page,
      summary.getByRole("status"),
      dockRegion(page, "activity"),
      page.locator("[data-prompt-dock]"),
    );
    await expect(line).not.toHaveAttribute("title");
    await pressKey(activityFrame(page).locator("[data-feed-scroller]"), "Escape");
    await expect(summary).toHaveCount(0);

    // Every line, including the short Started line, not just cut words.
    const short = startedLine(page, task.key);
    await restOnWords(page, short);
    await expect(summary.locator("[data-line-summary-text]")).toHaveText(
      await short.locator("[data-feed-text]").innerText(),
    );
    await restOnTaskKey(page, taskKeyLinks(line));
    await expect(rowSummary(page)).toHaveAttribute("data-point-summary", task.id);
    await expect(summary).toHaveCount(0);
    await page.mouse.move(700, 400);
    const scroller = activityFrame(page).locator("[data-feed-scroller]");
    await pressKey(scroller, "Tab");
    await expect(taskKeyLinks(activityFrame(page)).first()).toBeFocused();
    await expect(rowSummary(page)).toHaveAttribute("data-point-summary", task.id);

    await dockRegion(page, "activity").getByRole("button", { name: "Collapse Activity" }).click();
    const header = dockRegion(page, "activity").locator("[data-panel-summary-line]");
    const newest = (await page.evaluate(() => window.infinitary.feed.recent())).at(-1);
    if (!newest) throw new Error("The collapsed header has no recorded line");
    await pressKey(
      dockRegion(page, "activity").getByRole("button", { name: "Expand Activity" }),
      "Shift+Tab",
    );
    await expect(header).toBeFocused();
    await expect(summary.locator("[data-line-summary-text]")).toHaveText(newest.text);
    await expect(header).not.toHaveAttribute("title");
    await pressKey(header, "Escape");
    await expect(summary).toHaveCount(0);
    await pressKey(header, "Enter");
    await expect(scroller).toBeVisible();
  } finally {
    await app.close();
  }
});
