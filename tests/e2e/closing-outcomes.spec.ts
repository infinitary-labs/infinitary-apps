import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { regionShot } from "./pictures";
import { expandDock, nowFrame, pressRow, recordFrame } from "./rails";
import { pressKey } from "./windowKeys";

async function openClosing(app: LaunchedApp, task: { key: string; title: string }) {
  await resizeWindow(app.app, app.page, { width: 1280, height: 800 });
  await expandDock(app.page, "now");
  await app.page
    .locator('[data-side-panel="now"] header')
    .getByRole("button", { name: "Search tasks" })
    .click();
  await nowFrame(app.page).locator("[data-now-query]").fill(task.title);
  await pressRow(app.page, task.key);
  const activity = recordFrame(app.page).locator('[data-record-section="timeline"]');
  if (!(await activity.evaluate((node) => (node as HTMLDetailsElement).open)))
    await pressKey(activity.locator(":scope > summary"), "Enter");
  const closing = activity.locator('[data-record-event="status"]');
  if (!(await closing.evaluate((node) => (node as HTMLDetailsElement).open)))
    await pressKey(closing.locator(":scope > summary"), "Enter");
  return { activity, closing };
}

/** INF-1484 E1: existing-user answers and operation results remain on their closing Activity row.
 * Data: completed question/operation records written by their actual owners, with no report.
 * Signal: exact saved outcome visible after keyboard expansion. Isolated app/data; no shared resources.
 * Platform: the desktop hermetic launcher only, with no native input, real sign-in or device prerequisites.
 */
for (const kind of ["question", "operation"] as const) {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixture slot for testInfo; Electron owns the window.
  test(`closing ${kind} outcome`, async ({}, testInfo) => {
    const userDataDir = scratchDir("infinitary-closing-outcome-");
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({
      db,
      strict: true,
    });
    const input = {
      id: "closing-outcome",
      title:
        kind === "question"
          ? "Why did the practice release stop?"
          : "Archive the old practice working copy",
      outcome:
        kind === "question"
          ? "The practice release stopped because its Mac check failed. The saved work is unchanged."
          : "I archived the old practice working copy. The newer working copy is unchanged.",
    };
    const task =
      kind === "question"
        ? tasks.fileQuestion(input)
        : tasks.fileOperation({ ...input, tool: "archive_task" });
    if (kind === "operation")
      tasks.fileQuestion({
        id: "navigation",
        title: "Where can I find completed work?",
        outcome: "Tasks search includes completed work.",
      });
    db.close();
    let app = await launchApp({ userDataDir, withMockProvider: true });
    try {
      let { activity, closing } = await openClosing(app, task);
      await expect(closing.locator("[data-record-whole]")).toHaveText(input.outcome);
      await regionShot(activity, testInfo.outputPath(`closing-${kind}.png`));
      const before = await app.page.evaluate((id) => window.infinitary.tasks.detail(id), task.id);
      await app.close();
      app = await launchApp({ userDataDir, withMockProvider: true });
      ({ activity, closing } = await openClosing(app, task));
      await expect(closing.locator("[data-record-whole]")).toHaveText(input.outcome);
      const after = await app.page.evaluate((id) => window.infinitary.tasks.detail(id), task.id);
      expect(after.timeline).toEqual(before.timeline);
      await testInfo.attach("closing-outcome", {
        body: Buffer.from(
          JSON.stringify(
            {
              input,
              visible: await closing.innerText(),
              before,
              after,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
    } finally {
      await app.close();
    }
  });
}
