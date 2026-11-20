import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { expandDock, openGroup, pressRow, recordCard, recordFrame } from "./rails";
import { WRITING_CREW_MARKER, writingCrew } from "./scenarios/writingCrew";
import { stageAtRest } from "./stack";

/**
 * Source: the reported Tasks-row wait. A working record after a shorter
 * closed record must draw before reveal, not appear through the hold expiry.
 * This needs Electron's served record frame: the browser layer cannot load it.
 * The writing crewmate supplies real task facts and progress through its tools.
 * The assertion owns ordering, not a machine-dependent millisecond budget.
 */
test("a working record draws before it replaces a shorter record from Tasks", async () => {
  const testInfo = test.info();
  const userDataDir = scratchDir("infinitary-record-replacement-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const closed = seedTask(tasks, {
    id: "finished-chart",
    title: "Chart checked",
    status: "completed",
  });
  tasks.close(closed.id, { status: "done", reason: "finished", actor: "host" });
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true, scenarios: [writingCrew] });
  try {
    const { page } = app;
    // The original app's default window: the facts wrap below the shorter
    // record's visible body here. A wider window hid this regression.
    await resizeWindow(app.app, page, { width: 1200, height: 800 });
    await askFirstmate(page, `${SPAWN_PROMPT_MARKER} ${WRITING_CREW_MARKER}`, 60_000);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find((task) =>
            task.title.includes(WRITING_CREW_MARKER),
          )?.status,
      )
      .toBe("active");
    const working = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
      (task) => task.title.includes(WRITING_CREW_MARKER),
    );
    if (!working) throw new Error("The writing crewmate is missing");
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.infinitary.tasks.detail(id), working.id)).events.some(
          (event) => event.kind === "progress",
        ),
      )
      .toBe(true);
    await expandDock(page, "now");
    await openGroup(page, "landed");
    const replacements = [];
    // Cover both the first opening and a revisit after the shorter record.
    for (const visit of ["first", "again"]) {
      for (const task of [closed, working]) {
        await page.evaluate(() => {
          for (const mark of performance.getEntriesByType("mark"))
            if (mark.name.startsWith("stage:")) performance.clearMarks(mark.name);
        });
        await pressRow(page, task.key);
        await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
        await page.waitForFunction(() => performance.getEntriesByName("stage:visible").length > 0);
        await stageAtRest(page);
        if (task.id === closed.id) continue;
        const marks = await page.evaluate(() =>
          performance
            .getEntriesByType("mark")
            .filter((mark) => mark.name.startsWith("stage:"))
            .map((mark) => ({ name: mark.name, at: mark.startTime })),
        );
        replacements.push({ visit, marks });
        // Keep the app's own timing evidence even when the ordering fails.
        writeFileSync(
          testInfo.outputPath("replacements.json"),
          JSON.stringify(replacements, null, 2),
        );
        const drawn = marks.findIndex((mark) => mark.name === "stage:drawn");
        const visible = marks.findIndex((mark) => mark.name === "stage:visible");
        expect(drawn, "the record body draws instead of expiring the hold").toBeGreaterThanOrEqual(
          0,
        );
        expect(drawn, "body drawing precedes reveal").toBeLessThan(visible);
        await expect(
          recordFrame(page).locator('[data-record-section="details"] > summary'),
        ).toBeVisible();
      }
    }
  } finally {
    await app.close();
  }
});
