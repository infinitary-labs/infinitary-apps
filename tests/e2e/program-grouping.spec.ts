import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { activityFrame, expandDock, recordCard } from "./rails";
import { boardEntry, boardTile, laneCount, openBoardButton } from "./taskBoard";

import { focusOn, pressKey, typeInto } from "./windowKeys";

// INF-1137 friction 8, captain: only programs. A 29-part program folds
// while ordinary parents and children stay separate, and Find opens a
// folded part by keys. Private HOME/userData, no shared account or native input.
test("only programs fold their parts in Activity and the board, and Find keeps a part reachable", async () => {
  const userDataDir = scratchDir("program-pictures-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const root = seedTask(tasks, {
    id: "program",
    title: "Research the next release",
    status: "queued",
    startPolicy: "on-request",
    shape: { kind: "research", program: { script: "return null;", bound: 29 } },
  });
  for (let i = 0; i < 29; i++)
    seedTask(tasks, {
      id: `part-${i}`,
      parentId: root.id,
      title: `Research question ${i + 1}`,
      status: "queued",
      startPolicy: "on-request",
    });
  const ordinary = seedTask(tasks, {
    id: "ordinary",
    title: "Improve the website",
    status: "queued",
    startPolicy: "on-request",
  });
  seedTask(tasks, {
    id: "ordinary-child",
    parentId: ordinary.id,
    title: "Review the home page",
    status: "queued",
    startPolicy: "on-request",
  });
  for (const task of tasks.list())
    tasks.recordReport(task.id, { text: "Research queued for review." });
  const partKey = tasks.get("part-28")?.key ?? "";
  db.close();
  const app = await launchApp({ withMockProvider: true, userDataDir });
  try {
    await resizeWindow(app.app, app.page, { width: 1440, height: 1000 });
    await expandDock(app.page, "activity");
    await expect(activityFrame(app.page).locator("[data-feed-row]").first()).toBeVisible();
    await expandDock(app.page, "now");
    await openBoardButton(app.page).click();
    await expect(boardEntry(app.page)).toBeVisible();
    {
      await expect.poll(() => laneCount(app.page, "backlog")).toBe(3);
      await expect(activityFrame(app.page).locator(`[data-feed-key="${root.key}"]`)).toHaveCount(1);
      await expect(activityFrame(app.page).locator("[data-feed-row]")).toHaveCount(3);
      const feed = await app.page.evaluate(() => window.infinitary.feed.recent());
      expect(feed.filter((line) => line.taskKey === root.key)).toHaveLength(1);
      expect(feed.find((line) => line.taskKey === root.key)?.text).toContain("0/29 parts done");
      const find = boardEntry(app.page).locator("[data-board-find]");
      await focusOn(find);
      await typeInto(find, "Research question 29");
      const part = boardTile(app.page, partKey);
      await expect(part).toBeVisible();
      await focusOn(part);
      await pressKey(part, "Enter");
      await expect(recordCard(app.page)).toHaveAttribute("data-task-record", "part-28");
    }
  } finally {
    await app.close();
  }
});
