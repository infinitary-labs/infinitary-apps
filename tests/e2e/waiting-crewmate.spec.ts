import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { DEPENDENCY_VISUAL } from "../../src/shared/dependencyVisual";
import {
  dependencyWaitWords,
  taskStatusLabel,
  taskStatusOf,
} from "../../src/shared/taskPresentation";
import type { TaskView } from "../../src/shared/tasks";
import { taskWaitSummary, taskWaitText } from "../../src/shared/taskWaits";
import { scratchDir } from "../helpers/scratchDirs";
import { crewFormation } from "./crew";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockProvider";
import {
  expandDock,
  expectRecordBody,
  hideRecord,
  nowRow,
  pressRow,
  recordBar,
  recordBarButton,
  recordCard,
  rowSummary,
} from "./rails";
import { BOARD_PANEL, boardsOnStage, boardTile, hideBoard, openBoardButton } from "./taskBoard";
import { focusOn, pressKey } from "./windowKeys";

/**
 * INF-38, the captain's "Approve and build" of "Show why a crewmate is
 * waiting", with "i don't think we should render the text beneath the
 * crewmate. the center animation should be kept as clean as possible".
 * FI3-1788 was started and idle on FI3-1822, yet kept its own slot because
 * queued FI3-1789 waited on it; and nothing at a glance said what it waited
 * on or since when (INF-1137 friction 5). Here a started crewmate whose
 * blocker was linked after it started, with queued work waiting on it,
 * circles its blocker; its tile, Tasks row and summary name the wait and
 * when it was recorded; and when the blocker is dropped the wait clears.
 */

/** A crewmate's place on the stage: the centre of the anchor its label follows. */
async function placeOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.locator(`[data-crew-model-name="${id}"]`).evaluate((element) => {
    const anchor = element.parentElement;
    if (!anchor) throw new Error("crewmate anchor missing");
    const { x, y, width, height } = anchor.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
}

/** How far the waiter sits from its blocker, in scene pixels. */
async function apart(page: Page, waiter: string, blocker: string): Promise<number> {
  const [a, b, { scale }] = await Promise.all([
    placeOf(page, waiter),
    placeOf(page, blocker),
    crewFormation(page),
  ]);
  return Math.hypot(a.x - b.x, a.y - b.y) / scale;
}

/** The task board's card anywhere on the stage, still leaving or not. */
function boardPages(page: Page) {
  return page.locator(`[data-panel-card="${BOARD_PANEL}/board"]`);
}

function fixture(): string {
  const userDataDir = scratchDir("infinitary-waiting-crewmate-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  for (const [id, title] of [
    ["blocker", "Fix the harbour map tiles"],
    ["waiter", "Draw the harbour map legend"],
  ] as const) {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    // A routed model gives each crewmate the label anchor its place is read from.
    const model = { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID };
    seedTask(tasks, { id, title, status: "idle", worktreeDir, model });
  }
  seedTask(tasks, { id: "queued", title: "Print the harbour map", status: "queued" });
  // The waiter started first; its blocker is linked afterwards.
  tasks.graph.link("blocker", "waiter", "blocks", "crewmate");
  tasks.graph.link("waiter", "queued", "blocks", "host");
  db.close();
  return userDataDir;
}

test("a started crewmate idle on one blocker circles it past queued work, and its tile, row and summary name the wait", async () => {
  const app = await launchApp({ userDataDir: fixture(), withMockProvider: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1280, height: 1000 });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const row = (id: string): TaskView => {
      const task = board.tasks.find((each) => each.id === id);
      if (!task) throw new Error(`Missing fixture task ${id}`);
      return task;
    };
    const blocker = row("blocker");
    const waiter = row("waiter");
    expect(waiter).toMatchObject({
      status: "active",
      blockedBy: [blocker.key],
      workPosture: { state: "idle", reason: "dependency" },
    });
    expect(row("queued").blockedBy).toEqual([waiter.key]);
    const since = waiter.blockedSince?.[blocker.key];
    if (since === undefined) throw new Error("The wait's recorded time is missing");
    const reading = taskStatusOf(waiter);
    expect(reading.reason).toBe(dependencyWaitWords([blocker.key]));

    // Section 1: the stage. The waiter circles its blocker, close to it and
    // moving round it, although queued work waits on the waiter.
    const near = page.locator('canvas[data-crew-layer="near"]');
    await expect(near).toHaveAttribute("data-crew-arrows", "wait:waiter>blocker");
    const circle = DEPENDENCY_VISUAL.radiusPx * 1.25;
    await expect
      .poll(() => apart(page, "waiter", "blocker"), { timeout: 15_000 })
      .toBeLessThan(circle);
    const bearing = async () => {
      const [a, b] = await Promise.all([placeOf(page, "waiter"), placeOf(page, "blocker")]);
      return Math.atan2(a.y - b.y, a.x - b.x);
    };
    const first = await bearing();
    await expect.poll(async () => Math.abs((await bearing()) - first)).toBeGreaterThan(0.2);
    expect(await apart(page, "waiter", "blocker")).toBeLessThan(circle);
    // No words for the wait are drawn beneath the crewmate.
    await expect(page.locator("[data-crew-formation]")).not.toContainText(blocker.key);

    // Section 2: the Tasks row and its summary, from the keyboard.
    await expandDock(page, "now");
    const waiterRow = nowRow(page, waiter.key);
    await expect(waiterRow.locator("[data-now-word]")).toHaveText(" · waiting");
    await expect(waiterRow.locator("[data-task-mark]")).toHaveAttribute(
      "aria-label",
      taskStatusLabel(reading),
    );
    await focusOn(waiterRow);
    await expect(rowSummary(page)).toBeVisible();
    const summary = rowSummary(page).locator("[data-crew-summary]");
    // INF-2528, the captain's direction B: the preview keeps the short
    // status and names the blocker by its key alone.
    await expect(summary.locator('[data-task-fact="status"]')).toHaveText(taskStatusLabel(reading));
    await expect(summary.locator(`[data-crew-blocked-wait="${blocker.key}"]`)).toHaveText(
      blocker.key,
    );
    // The exact recorded date, with the unknown end time (INF-2215), is the task card's.
    const dependency = waiter.waits?.find((wait) => wait.kind === "dependency");
    if (!dependency) throw new Error("Missing the standing dependency wait");
    expect(dependency.since).toBe(since);
    await pressKey(waiterRow, "Enter");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "waiter");
    await expectRecordBody(page);
    await expect(recordCard(page).locator("[data-record-attention-title]")).toContainText(
      taskWaitText(dependency, Date.now()),
    );
    await hideRecord(page).click();
    await expect(recordCard(page)).toHaveCount(0);

    // Section 3: the task board's tile.
    await openBoardButton(page).click();
    const tile = boardTile(page, waiter.key);
    const grouped = taskWaitSummary(waiter.waits ?? [], Date.now());
    if (!grouped) throw new Error("Missing grouped tile wait");
    await expect(tile.locator("[data-board-status]")).toContainText(reading.word);
    await expect(tile.locator("[data-board-wait]")).toContainText(grouped.names);
    await expect(tile.locator("[data-board-wait]")).toContainText(grouped.event);
    await expect(tile.locator("[data-board-wait-since]")).toHaveCount(0);
    await hideBoard(page).click();
    await expect(boardsOnStage(page)).toHaveCount(0);
    // The board's own Tasks page leaves the stage after its card does.
    await expect(boardPages(page)).toHaveCount(0);

    // Section 4: the captain drops the blocker. The wait clears everywhere
    // and the waiter leaves the blocker's circle for its own slot.
    await pressRow(page, blocker.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "blocker");
    await expectRecordBody(page);
    await recordBarButton(page, "end").click();
    await expect(recordBar(page)).toHaveAttribute("data-record-footer", "confirm");
    await recordBarButton(page, "next").click();
    await expect
      .poll(async () => {
        const now = await page.evaluate(() => window.infinitary.tasks.board());
        return now.tasks.find((task) => task.id === "blocker")?.status;
      })
      .toBe("dropped");
    if ((await recordCard(page).count()) > 0) await hideRecord(page).click();
    await expect(waiterRow.locator("[data-now-word]")).toHaveCount(0);
    await expect(near).not.toHaveAttribute("data-crew-arrows", /wait:waiter>blocker/);
  } finally {
    await app.close();
  }
});
