import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { FIDGET_DURATION_MS } from "../../src/renderer/src/character/machine";
import { WARP_VARIANTS, type WarpVariant } from "../../src/renderer/src/character/warp";
import { scratchDir } from "../helpers/scratchDirs";
import { crewPlaneCounts, waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";

/**
 * The warp fidgets (INF-1755; the captain's ask, INF-1750: "i want this
 * fidget animation to look like the whole crew is traveling through space at
 * warp speed like through a wormhole", and their choice of all three
 * treatments, "add all 3 actually"). A tap on the idle first mate draws a
 * fidget from the pool; the draw is held to one warp by a fixed random
 * number, so each test plays its own warp end to end.
 *
 * Promised result: the warp plays, the crew circling the first mate ride it
 * faster round their orbits, and when it ends the first mate is idle again
 * and the crew are back at their own pace on the same orbits.
 * Data: six seeded idle crew on this computer. Completion signal: the near
 * crew canvas's `data-crew-warp` and `data-crew-travel`, and the first mate
 * idle again. Platform prerequisites and shared resources: none beyond
 * the hermetic launch.
 */

const CREW = 6;

function roster(): string {
  const userDataDir = scratchDir("infinitary-warp-roster-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  for (let i = 0; i < CREW; i++) {
    // A real idle task has a workspace, or boot starts it again.
    const worktreeDir = join(userDataDir, "crew", String(i));
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, {
      id: `warp-crew-${i}`,
      title: `Warp crew ${i}`,
      status: "idle",
      worktreeDir,
      outcome: "Fixture crew is waiting for the captain.",
      createdAt: Date.now() + i,
    });
  }
  db.close();
  return userDataDir;
}

const character = (page: Page) =>
  page.getByRole("img", { name: /^First mate - /, includeHidden: true });
const near = (page: Page) => page.locator('canvas[data-crew-layer="near"]');

for (const variant of WARP_VARIANTS) {
  test(`a tap on the idle first mate plays the ${variant} warp and takes the crew along`, async () => {
    test.setTimeout(90_000);
    const launched = await launchApp({ userDataDir: roster(), withMockProvider: true });
    try {
      const { page } = launched;
      // The pool draws by key order, so this number picks the warp; the
      // first mate's own idle fidget waits longer than the test takes.
      const pool = Object.keys(FIDGET_DURATION_MS) as WarpVariant[];
      const pick = (pool.indexOf(variant) + 0.5) / pool.length;
      await page.addInitScript((value) => {
        Math.random = () => value;
      }, pick);
      await page.reload();
      await waitForFirstmateIdle(page);
      const orbits = await crewPlaneCounts(page);
      expect(orbits.reduce((sum, n) => sum + n, 0)).toBe(CREW);

      await character(page).dispatchEvent("pointerdown");
      await expect(near(page)).toHaveAttribute("data-crew-warp", variant);
      // At warp speed the crew travel their orbits faster than their own pace.
      await expect
        .poll(async () => Number(await near(page).getAttribute("data-crew-travel")), {
          intervals: [50],
        })
        .toBeGreaterThan(2);

      // The warp ends on its own: the first mate is idle, the crew at their
      // own pace on the orbits they started on.
      await waitForFirstmateIdle(page, FIDGET_DURATION_MS[variant] + 10_000);
      await expect(near(page)).not.toHaveAttribute("data-crew-warp", /./);
      await expect(near(page)).toHaveAttribute("data-crew-travel", "1");
      expect(await crewPlaneCounts(page)).toEqual(orbits);
    } finally {
      await launched.close();
    }
  });
}
