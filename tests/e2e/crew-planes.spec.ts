import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { crewPlaneCounts, crewSummary, pointAtCrewmate } from "./crew";
import { launchApp } from "./launch";
import { expectClearOf, intersects, minimumWindowSize, resizeWindow, within } from "./layout";
import { promptInput } from "./prompt";

const crewTitle = (index: number) => `Orbit crew ${index}`;

function roster(count: number) {
  const userDataDir = scratchDir("infinitary-plane-roster-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  for (let i = 0; i < count; i++) {
    // A real idle task has a workspace. Without one, boot correctly treats
    // these fixtures as interrupted dispatches and starts them again.
    const worktreeDir = join(userDataDir, "crew", String(i));
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, {
      id: `plane-crew-${i}`,
      title: crewTitle(i),
      status: "idle",
      worktreeDir,
      outcome: "Fixture crew is waiting for the captain.",
      createdAt: Date.now() + i,
    });
  }
  db.close();
  return userDataDir;
}

const CREW = 48;

test(`at the smallest window ${CREW} crew all fit the stage above the prompt, and a crewmate can still be read`, async () => {
  const app = await launchApp({ userDataDir: roster(CREW), withMockProvider: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, await minimumWindowSize(app.app));
    expect((await page.evaluate(() => window.infinitary.crew.counts())).idle).toBe(CREW);
    // Every crewmate is on the stage.
    await expect
      .poll(async () => (await crewPlaneCounts(page)).reduce((sum, n) => sum + n, 0))
      .toBe(CREW);
    const viewport = await page.evaluate(() => ({
      x: 0,
      y: 0,
      width: innerWidth,
      height: innerHeight,
    }));
    const box = async (locator: Locator) => {
      const found = await locator.boundingBox();
      if (!found) throw new Error(`${locator} is not laid out`);
      return found;
    };
    // The crowded orbit stays in the window and clear of the prompt.
    const orbit = await box(page.locator('canvas[data-crew-layer="near"]'));
    expect(within(orbit, viewport)).toEqual([]);
    expect(intersects(orbit, await box(promptInput(page)))).toBe(false);
    // Pointing at one opens its summary, whole inside the window. Read once it
    // has settled: the task record fills it in after it opens, and the next
    // frame places it again for its new size.
    const { id } = await pointAtCrewmate(page);
    await expect(crewSummary(page)).toHaveAttribute("data-crew-summary", id);
    await expectClearOf(page, crewSummary(page));
    await page.screenshot({ path: test.info().outputPath(`${CREW}-crew-minimum-window.png`) });
  } finally {
    await app.close();
  }
});
