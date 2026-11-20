import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { expandDock, nowFrame, nowRow } from "./rails";
import { pressKey } from "./windowKeys";

/**
 * INF-3750's option B, which the captain chose to start: the window's first
 * task board read leaves out the week's closed tasks, and Tasks reads them
 * when the captain opens Done. Promised result: Done still counts the work
 * closed before the window opened, and opening it from the keyboard lists
 * each of those tasks. Data: real TaskService records saved before launch,
 * three closed this week and one still queued. Completion: the Done count,
 * then each closed task's row. Hidden window, isolated HOME and userData,
 * no accounts or shared resources.
 */
test("Done counts the week's closed work before reading it, and lists it once opened", async () => {
  const userDataDir = scratchDir("infinitary-board-closed-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "queued",
    title: "Tidy the onboarding copy",
    status: "queued",
    startPolicy: "on-request",
  });
  const closed = [
    "Group the release notes by feature area",
    "Fix the crew orbit's hover summary",
    "Measure the phone's catch-up read",
  ].map((title, index) => {
    const id = `closed-${index}`;
    seedTask(tasks, { id, title, status: "idle", startPolicy: "on-request" });
    tasks.close(id, { status: "done", reason: "landed", actor: "captain" });
    return tasks.get(id)?.key ?? "";
  });
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    await expandDock(page, "now");
    const frame = nowFrame(page);
    const header = frame.locator('[data-now-group-header="landed"]');
    await expect(frame.locator('[data-now-count="landed"]')).toHaveText(String(closed.length));
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await pressKey(header, "Enter");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    for (const key of closed) await expect(nowRow(page, key)).toBeVisible();
    await expect(frame.locator('[data-now-count="landed"]')).toHaveText(String(closed.length));
  } finally {
    await app.close();
  }
});
