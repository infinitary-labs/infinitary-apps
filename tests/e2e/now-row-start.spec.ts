import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { ROW_START_LABEL, ROW_TRY_AGAIN_LABEL } from "../../src/panels/now/words";
import type { TaskBoard } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { expandDock, nowFrame, nowRow, nowRowGroup, openGroup, restOnRow } from "./rails";
import { focusedRegion, focusOn, regionAfter } from "./windowKeys";

/**
 * A backlog row's Start in the Tasks panel (INF-1663, the captain's words:
 * "when i mouse hover each task row in the tasks panel in the backlog
 * section, i would love it to give me a start button that can just start
 * it", built as direction A of INF-1662), the way the captain uses it: by
 * keys - → from a focused backlog row reaches its Start, ← goes back, Enter
 * starts the task at once and focus follows its row out of the backlog -
 * and by the pointer, where resting on a row shows its Start, Try again on a
 * row whose start failed. A blocked row's Start is dim, says the record's
 * reason, and writes nothing.
 *
 * Data: three backlog tasks on request and the task one of them waits on,
 * one of them a start that could not be made, with the stand-in crewmate.
 * Completion: the task's own record (`tasks.detail`) reads it started, or
 * still open with nothing dispatched.
 */

function seeded(): string {
  const userDataDir = scratchDir("infinitary-now-row-start-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  let at = Date.now() - 60_000;
  const next = () => {
    at += 1_000;
    return at;
  };
  const seed = (id: string, title: string) =>
    seedTask(tasks, {
      id,
      title,
      intent: { goal: `${title}.`, userWords: `${title}.` },
      startPolicy: "on-request",
      status: "queued",
      createdAt: next(),
    });
  seed("rs-keys", "Chart the harbour");
  seed("rs-first", "Survey the reef");
  seed("rs-blocked", "Sound the channel");
  tasks.graph.link("rs-first", "rs-blocked", "blocks", "host");
  seed("rs-again", "Sound the shoal");
  tasks.starts.returnStart("rs-again", {
    kind: "failed",
    reason: "its working copy could not be made",
  });
  db.close();
  return userDataDir;
}

const status = (page: Page, id: string) =>
  page.evaluate(
    (taskId) =>
      window.infinitary.tasks.detail(taskId).then((task) => ({
        status: task.status,
        dispatched: task.events.some((event) => event.kind === "dispatched"),
      })),
    id,
  );

test("a backlog row's Start starts its task by keys and by the pointer, and a blocked one says why", async () => {
  test.setTimeout(180_000);
  const userDataDir = seeded();
  const { app, page, close } = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const board: TaskBoard = await page.evaluate(() => window.infinitary.tasks.board());
    const key = (id: string) => board.tasks.find((task) => task.id === id)?.key as string;
    const list = nowFrame(page);
    const start = (id: string) => list.locator(`[data-now-start="${id}"]`);
    const focused = (selector: string) => list.locator(`${selector}:focus`);
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    await expect(nowRow(page, key("rs-keys"))).toBeVisible();

    await test.step("by keys: → reaches the row's Start, ← goes back, Enter starts it", async () => {
      await promptInput(page).click();
      let region = await focusedRegion(page);
      while (region !== "panel:now") region = await regionAfter(app, page, region, "F6");
      // The backlog's header is the list's first stop; ↓ rests on its first row.
      await expect(focused('[data-now-group-header="backlog"]')).toHaveCount(1);
      await page.keyboard.press("ArrowDown");
      await expect(focused(`[data-now-row="rs-keys"]`)).toHaveCount(1);
      await expect(start("rs-keys")).toHaveCSS("opacity", "1");
      await expect(start("rs-keys")).toHaveText(ROW_START_LABEL);
      await page.keyboard.press("ArrowRight");
      await expect(focused(`[data-now-start="rs-keys"]`)).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(focused(`[data-now-row="rs-keys"]`)).toHaveCount(1);
      await page.keyboard.press("ArrowRight");
      await expect(focused(`[data-now-start="rs-keys"]`)).toHaveCount(1);
      await page.keyboard.press("Enter");
      // Started at once, with no question: its crewmate begins, and focus
      // follows its row out of the backlog.
      await expect
        .poll(() => status(page, "rs-keys"), { timeout: 30_000 })
        .toEqual({
          status: "active",
          dispatched: true,
        });
      await expect.poll(() => nowRowGroup(page, key("rs-keys"))).toBe("working");
      await expect(focused(`[data-now-row="rs-keys"]`)).toHaveCount(1);
    });

    await test.step("a blocked row's Start is dim, says what it waits on, and writes nothing", async () => {
      const blocked = board.tasks.find((task) => task.id === "rs-blocked");
      const reason = blocked?.moves?.["start-task"];
      expect(reason?.ok).toBe(false);
      // From the started row in Working: the backlog's header, the task it
      // waits on, then the blocked row.
      await page.keyboard.press("ArrowDown");
      await expect(focused('[data-now-group-header="backlog"]')).toHaveCount(1);
      await page.keyboard.press("ArrowDown");
      await expect(focused(`[data-now-row="rs-first"]`)).toHaveCount(1);
      await page.keyboard.press("ArrowDown");
      await expect(focused(`[data-now-row="rs-blocked"]`)).toHaveCount(1);
      await page.keyboard.press("ArrowRight");
      await expect(focused(`[data-now-start="rs-blocked"]`)).toHaveCount(1);
      await expect(start("rs-blocked")).toHaveAttribute("aria-disabled", "true");
      await expect(start("rs-blocked")).toHaveAccessibleDescription(
        reason && !reason.ok ? reason.text : "",
      );
      await page.keyboard.press("Enter");
      // The press writes nothing: the task still waits in the backlog.
      expect(await status(page, "rs-blocked")).toEqual({ status: "open", dispatched: false });
      await expect.poll(() => nowRowGroup(page, key("rs-blocked"))).toBe("backlog");
    });

    await test.step("by the pointer: resting on a row that could not start shows Try again, and a press starts it", async () => {
      await restOnRow(page, key("rs-again"));
      await expect(start("rs-again")).toHaveCSS("opacity", "1");
      await expect(start("rs-again")).toHaveText(ROW_TRY_AGAIN_LABEL);
      // The captain's click gives the panel's page the window's focus;
      // Chromium hands a hidden window's native click to a frame unreliably.
      await focusOn(start("rs-again"));
      await start("rs-again").evaluate((button) => (button as HTMLElement).click());
      await expect
        .poll(() => status(page, "rs-again"), { timeout: 30_000 })
        .toEqual({
          status: "active",
          dispatched: true,
        });
      await expect.poll(() => nowRowGroup(page, key("rs-again"))).toBe("working");
    });
  } finally {
    await close();
  }
});
