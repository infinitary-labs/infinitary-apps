import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { pinActionLabel } from "../../src/shared/taskPin";
import { BOARD_RECENT_MS } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { expandDock, nowFrame, nowRow, nowRowGroup, openGroup, restOnRow } from "./rails";
import { focusedRegion, focusOn, regionAfter } from "./windowKeys";

/**
 * Pinning a task to the top of Tasks (INF-3127, the captain's words: "when a
 * task is pinned, it always show in a "pinned" section in the tasks panel at
 * the top, no matter what state it's in. each task row in the tasks panel
 * should have a hover button to pin/unpin, the button should use a pin icon
 * no text"), the way the captain uses it: by keys - → from a focused row
 * reaches its buttons, → again its pin, Enter pins it and focus follows its
 * row into Pinned - and by the pointer, where resting on a row shows its pin,
 * done work closed long ago is found by a search and pinned, and a pinned
 * task's filled pin unpins it back under its state. Pinned rows keep the
 * order they were pinned in, newest last.
 *
 * Data: two backlog tasks on request and one finished nine days ago, past
 * the board's week. Completion: the task's own record (`tasks.detail`)
 * reads its pin, and the row's group says where the panel lists it.
 */

const DAY = 24 * 60 * 60 * 1000;
const OLD_TITLE = "Retire the lighthouse page";

function seeded(): string {
  const userDataDir = scratchDir("infinitary-now-pin-");
  const db = openDatabase(userDataDir);
  const now = Date.now();
  let clock = now - 9 * DAY;
  expect(9 * DAY).toBeGreaterThan(BOARD_RECENT_MS);
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  tasks.create({ id: "pn-old", title: OLD_TITLE, prompt: "p", repoId: null });
  tasks.close("pn-old", { status: "done", reason: "settled", actor: "host" });
  clock = now - 60_000;
  for (const [id, title] of [
    ["pn-first", "Chart the harbour"],
    ["pn-second", "Survey the reef"],
  ] as const) {
    clock += 1_000;
    seedTask(tasks, {
      id,
      title,
      intent: { goal: `${title}.`, userWords: `${title}.` },
      startPolicy: "on-request",
      status: "queued",
      createdAt: clock,
    });
  }
  db.close();
  return userDataDir;
}

const pinnedAt = (page: Page, id: string) =>
  page.evaluate(
    (taskId) => window.infinitary.tasks.detail(taskId).then((task) => task.pinnedAt ?? null),
    id,
  );

test("a row's pin keeps its task at the top of Tasks by keys and by the pointer, whatever its state", async () => {
  test.setTimeout(180_000);
  const { app, page, close } = await launchApp({ userDataDir: seeded(), withMockProvider: true });
  try {
    const key = async (id: string) =>
      (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id)).key;
    const firstKey = await key("pn-first");
    const secondKey = await key("pn-second");
    const oldKey = await key("pn-old");
    const list = nowFrame(page);
    const pin = (id: string) => list.locator(`[data-now-pin="${id}"]`);
    const focused = (selector: string) => list.locator(`${selector}:focus`);
    const pinnedKeys = () =>
      list
        .locator('[data-now-group="pinned"] [data-now-row]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-now-key")));
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    await expect(nowRow(page, firstKey)).toBeVisible();
    await expect(list.locator('[data-now-group="pinned"]')).toHaveCount(0);

    await test.step("by keys: → reaches the row's Start, → its pin, Enter pins it", async () => {
      await promptInput(page).click();
      let region = await focusedRegion(page);
      while (region !== "panel:now") region = await regionAfter(app, page, region, "F6");
      await expect(focused('[data-now-group-header="backlog"]')).toHaveCount(1);
      await page.keyboard.press("ArrowDown");
      await expect(focused('[data-now-row="pn-first"]')).toHaveCount(1);
      await expect(pin("pn-first")).toHaveCSS("opacity", "1");
      await expect(pin("pn-first")).toHaveAccessibleName(pinActionLabel(false, firstKey));
      await page.keyboard.press("ArrowRight");
      await expect(focused('[data-now-start="pn-first"]')).toHaveCount(1);
      await page.keyboard.press("ArrowRight");
      await expect(focused('[data-now-pin="pn-first"]')).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(focused('[data-now-start="pn-first"]')).toHaveCount(1);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect.poll(() => pinnedAt(page, "pn-first")).not.toBeNull();
      await expect.poll(() => nowRowGroup(page, firstKey)).toBe("pinned");
      await expect(focused('[data-now-row="pn-first"]')).toHaveCount(1);
      await expect(pin("pn-first")).toHaveAttribute("aria-pressed", "true");
      await expect(pin("pn-first")).toHaveAccessibleName(pinActionLabel(true, firstKey));
    });

    await test.step("by the pointer: resting on a row shows its pin, and a press pins it last", async () => {
      await restOnRow(page, secondKey);
      await expect(pin("pn-second")).toHaveCSS("opacity", "1");
      await expect(pin("pn-second")).toHaveAttribute("aria-pressed", "false");
      // The captain's click gives the panel's page the window's focus;
      // Chromium hands a hidden window's native click to a frame unreliably.
      await focusOn(pin("pn-second"));
      await pin("pn-second").evaluate((button) => (button as HTMLElement).click());
      await expect.poll(() => pinnedAt(page, "pn-second")).not.toBeNull();
      await expect.poll(pinnedKeys).toEqual([firstKey, secondKey]);
      // A pinned task lists in Pinned alone: the backlog no longer holds either.
      await expect(list.locator('[data-now-group="backlog"]')).toHaveCount(0);
    });

    await test.step("done work closed long ago is found by a search, pinned, and stays at the top", async () => {
      await page
        .locator('[data-side-panel="now"]')
        .getByRole("button", { name: "Search tasks" })
        .click();
      const query = list.locator("[data-now-query]");
      await query.fill("lighthouse");
      await expect(nowRow(page, oldKey)).toHaveCount(1);
      expect(await nowRowGroup(page, oldKey)).toBe("earlier");
      await focusOn(pin("pn-old"));
      await pin("pn-old").evaluate((button) => (button as HTMLElement).click());
      await expect.poll(() => pinnedAt(page, "pn-old")).not.toBeNull();
      await expect.poll(() => nowRowGroup(page, oldKey)).toBe("pinned");
      await query.fill("");
      await expect.poll(pinnedKeys).toEqual([firstKey, secondKey, oldKey]);
      await expect(nowRow(page, oldKey)).toHaveAttribute("data-now-status", "done");
    });

    await test.step("a pinned task's filled pin unpins it back under its state", async () => {
      await restOnRow(page, firstKey);
      await focusOn(pin("pn-first"));
      await pin("pn-first").evaluate((button) => (button as HTMLElement).click());
      await expect.poll(() => pinnedAt(page, "pn-first")).toBeNull();
      await expect.poll(() => nowRowGroup(page, firstKey)).toBe("backlog");
      await expect.poll(pinnedKeys).toEqual([secondKey, oldKey]);
    });
  } finally {
    await close();
  }
});
