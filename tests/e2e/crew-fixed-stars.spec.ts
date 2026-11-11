import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { FIXED_STARS } from "../../src/renderer/src/character/crew/fixedStars";
import { planeRadius } from "../../src/renderer/src/character/crew/orbitalPlanes";
import { PINNED_MARK_LABEL, pinActionLabel } from "../../src/shared/taskPin";
import { scratchDir } from "../helpers/scratchDirs";
import { crewFormation, crewInspecting, crewSummary, nextFrame } from "./crew";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockModels";
import { expandDock, nowFrame, nowRow } from "./rails";
import { focusOn } from "./windowKeys";

/**
 * Fixed stars (INF-3634, the captain's Approve and build of "Try the fixed
 * stars with a new look and new places": the constellation in the upper-left
 * sky, the glint, every crewmate the Tasks panel lists under Pinned, and the
 * filled pin beside the key in its summary). A crewmate whose task the
 * captain pins from its Tasks row by keys leaves its orbit for a place in the
 * upper-left sky, clear of the orbit; pointing at it opens a summary that
 * wears the pin; unpinning it by keys sends it back to a seat on the orbit.
 *
 * Data: four started crewmates, idle, each with a routed model so its name
 * anchor tells where it is drawn. Completion: the stage's own reading of the
 * stars it painted (`data-crew-stars`) and of the crew on each orbit
 * (`data-plane-crew`).
 */

const CREW = [
  ["fs-one", "Chart the harbour"],
  ["fs-two", "Survey the reef"],
  ["fs-three", "Light the buoys"],
  ["fs-four", "Map the tide pools"],
] as const;

function fixture(): string {
  const userDataDir = scratchDir("infinitary-fixed-stars-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  for (const [id, title] of CREW) {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    const model = { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID };
    seedTask(tasks, { id, title, status: "idle", worktreeDir, model });
  }
  db.close();
  return userDataDir;
}

/** Where a crewmate is drawn, read off the anchor its name follows. */
async function placeOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.locator(`[data-crew-model-name="${id}"]`).evaluate((element) => {
    const anchor = element.parentElement;
    if (!anchor) throw new Error("crewmate anchor missing");
    const { x, y, width, height } = anchor.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
}

const near = (page: Page) => page.locator('canvas[data-crew-layer="near"]');

test("a crewmate whose task is pinned from its Tasks row by keys hangs as a fixed star in the upper-left sky, and unpinning returns it to the orbit", async () => {
  test.setTimeout(180_000);
  const { app, page, close } = await launchApp({ userDataDir: fixture(), withMockProvider: true });
  try {
    await resizeWindow(app, page, { width: 1280, height: 1000 });
    const key = async (id: string) =>
      (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id)).key;
    const twoKey = await key("fs-two");
    const list = nowFrame(page);
    const pin = list.locator('[data-now-pin="fs-two"]');
    await expect(near(page)).toHaveAttribute("data-plane-crew", /fs-two/, { timeout: 30_000 });
    await expect(near(page)).toHaveAttribute("data-crew-stars", "");

    /** From the focused row, → walks its buttons until its pin has focus; Enter presses it. */
    const pressPin = async (pinned: boolean) => {
      await focusOn(nowRow(page, twoKey));
      for (
        let i = 0;
        i < 6 && (await list.locator('[data-now-pin="fs-two"]:focus').count()) === 0;
        i++
      )
        await page.keyboard.press("ArrowRight");
      await expect(list.locator('[data-now-pin="fs-two"]:focus')).toHaveCount(1);
      await expect(pin).toHaveAccessibleName(pinActionLabel(pinned, twoKey));
      await page.keyboard.press("Enter");
    };

    await test.step("pinned by keys, it leaves the orbit for a place in the upper-left sky", async () => {
      await expandDock(page, "now");
      await pressPin(false);
      await expect(near(page)).toHaveAttribute("data-crew-stars", "fs-two", { timeout: 15_000 });
      await expect(near(page)).not.toHaveAttribute("data-plane-crew", /fs-two/);
      const [star, centre] = await Promise.all([placeOf(page, "fs-two"), crewFormation(page)]);
      const dx = (star.x - centre.x) / centre.scale;
      const dy = (star.y - centre.y) / centre.scale;
      expect(dx).toBeLessThan(0);
      expect(dy).toBeLessThan(0);
      // Clear of the orbit's widest reach, and inside the stage.
      expect(Math.hypot(dx, dy)).toBeGreaterThan(planeRadius(0, [CREW.length]) * 1.06);
      expect(Math.max(Math.abs(dx), Math.abs(dy))).toBeLessThanOrEqual(FIXED_STARS.edgePx + 2);
    });

    await test.step("pointing at the star opens its summary with the filled pin beside its key", async () => {
      await expect
        .poll(async () => {
          const at = await placeOf(page, "fs-two");
          await page.mouse.move(at.x, at.y);
          await nextFrame(page);
          return crewInspecting(page);
        })
        .toBe("fs-two");
      const summary = crewSummary(page);
      await expect(summary).toHaveAttribute("data-crew-summary", "fs-two");
      await expect(summary.locator("[data-crew-summary-key]")).toHaveText(twoKey);
      await expect(summary.locator("[data-crew-summary-pinned]")).toHaveAccessibleName(
        PINNED_MARK_LABEL,
      );
      await page.mouse.move(4, 4);
    });

    await test.step("unpinned by keys, it returns to a seat on the orbit", async () => {
      await pressPin(true);
      await expect(near(page)).toHaveAttribute("data-crew-stars", "", { timeout: 15_000 });
      await expect(near(page)).toHaveAttribute("data-plane-crew", /fs-two/);
    });
  } finally {
    await close();
  }
});
