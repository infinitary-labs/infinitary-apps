import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { COLLAPSE_ALL_ASK, EXPAND_ALL_ASK, foldLabel } from "../../src/panels/now/words";
import { panelCommandId } from "../../src/shared/keyboard";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  expandDock,
  nowFrame,
  openGroup,
  openRowSummary,
  pressRow,
  recordCard,
  slideOnStill,
} from "./rails";
import { focusedRegion, regionAfter, runFromSearch } from "./windowKeys";

/**
 * Collapsing a task with parts in the Tasks panel (INF-3823's plan,
 * direction B, the captain's "Approve and build" with "None. Everything
 * starts expanded as today, and a task stays collapsed once you collapse
 * it." and "Every task filed under it, reviews and dropped ones included,
 * as the app counts today."), the way the captain uses it: by keys - ←
 * from a part goes up to its task, ← there collapses it, → expands it - a
 * restart that finds it still collapsed, and Expand all parts and Collapse
 * all parts from command search. Resting on a segment of the collapsed
 * task's bar rests on the part it names (INF-4147's plan, direction B, the
 * captain's "Every segment, finished ones too"): the finished part's
 * summary, then an open part's, then the task's own back on its title. A
 * click on a segment the pointer rests on opens the part it names, as a
 * click on that part's own row does (INF-4172), an open part and a finished
 * one, and a click on the row's title still opens the task.
 *
 * The pointer is Chromium's routed pointer, and it lands only once its
 * target is still (`slideOnStill`): the search before the clicks leaves the
 * keyboard in the panel's search field, and Playwright's mouse would take
 * the window's focus out of that frame and back, which lets the summary go;
 * the panel's frame also takes its new height a moment after the search
 * clears, which can carry the row out from under a pointer that landed
 * early (alpha run 43754442108).
 *
 * Data: a plan with three parts - one finished, two on request - so its
 * tree lists under Backlog and its row reads 1/3. Every task is queued on
 * request, since a seeded running task returns to the queue at launch.
 * Completion: the parts' rows leave and come back, the row's collapse
 * control says which, and its bar draws one segment per part; the summary
 * names the task the pointer rests on, and the record a click opens names
 * the task it opened.
 * Platforms: any; no Mac-only part. Shared resources: none beyond the app.
 */

function seeded(): string {
  const userDataDir = scratchDir("infinitary-now-collapse-");
  const db = openDatabase(userDataDir);
  let clock = Date.now() - 60_000;
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const seed = (id: string, title: string, parentId?: string) => {
    clock += 1_000;
    seedTask(tasks, {
      id,
      title,
      intent: { goal: `${title}.`, userWords: `${title}.` },
      startPolicy: "on-request",
      status: "queued",
      createdAt: clock,
      ...(parentId ? { parentId } : {}),
    });
  };
  seed("cl-plan", "Translate the app into other languages");
  seed("cl-words", "Word the app's own lines at view time", "cl-plan");
  seed("cl-ship", "Ship the first translated languages", "cl-plan");
  seed("cl-phone", "Plan the phone's languages", "cl-plan");
  tasks.close("cl-words", { status: "done", reason: "settled", actor: "host" });
  db.close();
  return userDataDir;
}

/** A rest on a bar segment lands below the drawn segment, inside its taller target. */
function belowBar(box: { width: number; height: number }): { x: number; y: number } {
  return { x: box.width / 2, y: box.height - 2 };
}

/** Puts the keyboard in the Tasks list with F6, as a person does. */
async function intoTasks(app: Parameters<typeof regionAfter>[0], page: Page): Promise<void> {
  await promptInput(page).click();
  let region = await focusedRegion(page);
  while (region !== "panel:now") region = await regionAfter(app, page, region, "F6");
}

test("a task with parts collapses and expands by keys and by command, and stays collapsed after a restart", async () => {
  test.setTimeout(240_000);
  const options = { userDataDir: seeded(), withMockProvider: true, gpuBenchmarking: true };
  let launched = await launchApp(options);
  try {
    let { app, page } = launched;
    const list = () => nowFrame(page);
    const row = (id: string) => list().locator(`[data-now-row="${id}"]`);
    const fold = () => list().locator('[data-now-fold="cl-plan"]');
    const focused = (id: string) => list().locator(`[data-now-row="${id}"]:focus`);
    const planKey = (await page.evaluate(() => window.infinitary.tasks.detail("cl-plan"))).key;
    const collapsedNow = async () => {
      await expect(row("cl-ship")).toHaveCount(0);
      await expect(row("cl-phone")).toHaveCount(0);
      await expect(fold()).toHaveAttribute("aria-expanded", "false");
      await expect(fold()).toHaveAccessibleName(foldLabel(true, planKey));
      await expect(row("cl-plan").locator("[data-now-bar] i")).toHaveCount(3);
    };
    const expandedNow = async () => {
      await expect(row("cl-ship")).toBeVisible();
      await expect(row("cl-phone")).toBeVisible();
      await expect(fold()).toHaveAttribute("aria-expanded", "true");
      await expect(fold()).toHaveAccessibleName(foldLabel(false, planKey));
      await expect(row("cl-plan").locator("[data-now-bar]")).toHaveCount(0);
    };

    await test.step("nothing starts collapsed, and the task reads its finished parts", async () => {
      await expandDock(page, "now");
      await openGroup(page, "backlog");
      await expandedNow();
      await expect(fold().locator("[data-now-parts]")).toHaveText("1/3");
    });

    await test.step("by keys: ← from a part goes to its task, ← collapses it, → expands it", async () => {
      await intoTasks(app, page);
      // F6 returns to the Backlog header this journey opened, and ↓ steps
      // from it to the task.
      await expect(list().locator('[data-now-group-header="backlog"]:focus')).toHaveCount(1);
      await page.keyboard.press("ArrowDown");
      await expect(focused("cl-plan")).toHaveCount(1);
      await page.keyboard.press("ArrowDown");
      await expect(focused("cl-ship")).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(focused("cl-plan")).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await collapsedNow();
      await expect(focused("cl-plan")).toHaveCount(1);
      await page.keyboard.press("ArrowRight");
      await expandedNow();
      await page.keyboard.press("ArrowLeft");
      await collapsedNow();
    });

    await test.step("a restart finds it still collapsed", async () => {
      await launched.close();
      launched = await launchApp(options);
      ({ app, page } = launched);
      await expandDock(page, "now");
      const backlog = list().locator('[data-now-group-header="backlog"]');
      await expect(backlog).toBeAttached();
      if ((await backlog.getAttribute("aria-expanded")) === "false")
        await openGroup(page, "backlog");
      await expect(row("cl-plan")).toBeVisible();
      await collapsedNow();
    });

    await test.step("resting on a segment opens the summary of the part it names", async () => {
      const segment = (index: number) => row("cl-plan").locator("[data-now-bar] i").nth(index);
      const summary = openRowSummary(page);
      // The finished part first, then the open ones as the board lists them.
      for (const [index, part] of [
        [0, "cl-words"],
        [1, "cl-ship"],
        [2, "cl-phone"],
      ] as const) {
        await slideOnStill(page, segment(index), belowBar);
        await expect(summary).toHaveAttribute("data-point-summary", part);
        await expect(segment(index)).toHaveAttribute("data-now-part-rested", "");
      }
      // The rest of the row (its status mark here) brings back the task's own summary.
      await slideOnStill(page, row("cl-plan").locator("[data-now-dot]"));
      await expect(summary).toHaveAttribute("data-point-summary", "cl-plan");
      await expect(row("cl-plan").locator("[data-now-part-rested]")).toHaveCount(0);
    });

    await test.step("Expand all parts and Collapse all parts from command search", async () => {
      await runFromSearch(app, page, panelCommandId("now", EXPAND_ALL_ASK));
      await expandedNow();
      await runFromSearch(app, page, panelCommandId("now", COLLAPSE_ALL_ASK));
      await collapsedNow();
    });

    await test.step("a search finds a part under a collapsed task, and leaves it collapsed", async () => {
      await page
        .locator('[data-side-panel="now"]')
        .getByRole("button", { name: "Search tasks" })
        .click();
      const query = list().locator("[data-now-query]");
      await query.fill("phone");
      await expect(row("cl-phone")).toBeVisible();
      await query.fill("");
      await collapsedNow();
    });

    await test.step("a click on a segment opens the part it names, as its own row does", async () => {
      const segment = (index: number) => row("cl-plan").locator("[data-now-bar] i").nth(index);
      // An open part, then the finished one, each pressed where the pointer rests on it.
      for (const [index, part] of [
        [1, "cl-ship"],
        [0, "cl-words"],
      ] as const) {
        await slideOnStill(page, segment(index), belowBar);
        await expect(openRowSummary(page)).toHaveAttribute("data-point-summary", part);
        await pressRow(page, planKey, `[data-now-part-index="${index}"]`);
        await expect(recordCard(page)).toHaveAttribute("data-task-record", part);
      }
      await pressRow(page, planKey, "[data-now-title]");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", "cl-plan");
    });
  } finally {
    await launched.close();
  }
});
