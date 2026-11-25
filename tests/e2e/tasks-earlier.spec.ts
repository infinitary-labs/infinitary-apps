import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { BOARD_RECENT_MS } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { expandDock, nowFrame, nowRow, nowRowGroup, recordCard } from "./rails";
import { clickInBody } from "./stack";
import { boardEntry, boardTile, boardViewTab, openBoardButton, pressInBoard } from "./taskBoard";
import { focusOn } from "./windowKeys";

/**
 * The Tasks filter reaches earlier work (FI3-579 piece 3): typed text also
 * finds closed work older than the board's seven days and dropped work, in an
 * `earlier` group, and a result opens its record. Nothing earlier is listed
 * until text is typed, and the normal groups stay as they were.
 */

const DAY = 24 * 60 * 60 * 1000;
const OLD_TITLE = "Reconcile idle answers";

test("typed filter text finds eight-day-old and dropped work and opens its record", async () => {
  const userDataDir = scratchDir("infinitary-earlier-");
  const db = openDatabase(userDataDir);
  const now = Date.now();
  let clock = now - 8 * DAY - 1;
  expect(8 * DAY).toBeGreaterThan(BOARD_RECENT_MS);
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  tasks.create({ id: "old-done", title: OLD_TITLE, prompt: "p", repoId: null });
  tasks.create({ id: "dropped", title: "Stalled zebra follow-up", prompt: "p", repoId: null });
  tasks.create({ id: "recent", title: "Recent zebra work", prompt: "p", repoId: null });
  tasks.close("old-done", { status: "done", reason: "settled", actor: "host" });
  clock = now - DAY;
  tasks.close("dropped", { status: "dropped", reason: "superseded", actor: "host" });
  clock = now;
  tasks.close("recent", { status: "done", reason: "settled", actor: "host" });
  // Open work the host never starts: work it starts fails with no signed-in
  // model and puts up a sign-in card at no set moment, and a card's page born
  // while the keyboard is in the search takes the window's focus at the next
  // key, which can lose that key's text (docs/e2e-contracts.md).
  tasks.create({
    id: "live",
    title: "Planned live work",
    prompt: "p",
    repoId: null,
    startPolicy: "on-request",
  });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    const board = () => page.evaluate(() => window.infinitary.tasks.board());
    const key = async (id: string) => {
      const found = (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id))
        .key;
      return found;
    };
    await expect
      .poll(async () => (await board()).tasks.map((task) => task.id))
      .toEqual(expect.arrayContaining(["dropped", "live", "recent"]));
    expect((await board()).tasks.map((task) => task.id)).not.toContain("old-done");
    const oldKey = await key("old-done");
    const droppedKey = await key("dropped");

    await expandDock(page, "now");
    const frame = nowFrame(page);
    const panel = page.locator('[data-side-panel="now"]');
    await expect(frame.locator('[data-now-group="landed"]')).toBeVisible();
    await expect(frame.locator('[data-now-group="earlier"]')).toHaveCount(0);
    await expect(nowRow(page, oldKey)).toHaveCount(0);
    await expect(nowRow(page, droppedKey)).toHaveCount(0);

    await panel.getByRole("button", { name: "Search tasks" }).click();
    const query = frame.locator("[data-now-query]");
    await expect(query).toBeFocused();

    await query.fill("idle");
    await expect(nowRow(page, oldKey)).toHaveCount(1);
    expect(await nowRowGroup(page, oldKey)).toBe("earlier");
    await expect(nowRow(page, oldKey)).toHaveAttribute("data-now-status", "done");

    await query.fill("zebra");
    await expect(nowRow(page, droppedKey)).toHaveCount(1);
    expect(await nowRowGroup(page, droppedKey)).toBe("earlier");
    await expect(nowRow(page, oldKey)).toHaveCount(0);
    await expect(frame.locator('[data-now-count="landed"]')).toHaveText("1");

    await query.fill("idle");
    const row = nowRow(page, oldKey);
    await focusOn(row);
    await expect(row).toBeFocused();
    await row.press("Enter");
    await expect(recordCard(page)).toContainText(OLD_TITLE);
    await expect(nowRow(page, oldKey)).toHaveAttribute("data-now-selected", "");

    await query.fill("");
    await expect(frame.locator('[data-now-group="earlier"]')).toHaveCount(0);
    await expect(nowRow(page, oldKey)).toHaveCount(0);
    await expect(frame.locator('[data-now-group="landed"]')).toBeVisible();
  } finally {
    await launched.close();
  }
});

test("typing a task key shows that task's row, even in a collapsed group", async () => {
  const userDataDir = scratchDir("infinitary-keysearch-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  tasks.create({ id: "done-today", title: "Recover the next card", prompt: "p", repoId: null });
  tasks.close("done-today", { status: "done", reason: "settled", actor: "host" });
  seedTask(tasks, {
    id: "planned",
    title: "Planned keyboard work",
    startPolicy: "on-request",
    status: "queued",
  });
  tasks.create({ id: "question", kind: "question", title: "Gauge", prompt: "p", repoId: null });
  tasks.close("question", { status: "done", reason: "answered", actor: "host" });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(3);
    await expandDock(page, "now");
    const frame = nowFrame(page);
    await expect(frame.locator('[data-now-group-header="landed"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page
      .locator('[data-side-panel="now"]')
      .getByRole("button", { name: "Search tasks" })
      .click();
    const query = frame.locator("[data-now-query]");
    await expect(query).toBeFocused();
    for (const id of ["done-today", "planned", "question"]) {
      const key = (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id)).key;
      for (const typed of [key, key.toLowerCase(), key.slice(key.lastIndexOf("-") + 1)]) {
        await query.fill(typed);
        await expect(nowRow(page, key), `${id} found by "${typed}"`).toBeVisible();
      }
    }
    await query.fill("");
    await expect(frame.locator('[data-now-group-header="landed"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  } finally {
    await launched.close();
  }
});

test("a plain apostrophe or quote typed finds a title written with a curly one", async () => {
  const userDataDir = scratchDir("infinitary-curlysearch-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  // The startup release note's record, titled as the app writes it.
  tasks.create({
    id: "note",
    kind: "question",
    title: "What’s new in 0.1.28",
    prompt: "p",
    repoId: null,
  });
  tasks.close("note", { status: "done", reason: "answered", actor: "host" });
  seedTask(tasks, {
    id: "planned",
    title: "Rename the “Later” group",
    startPolicy: "on-request",
    status: "queued",
  });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    const key = async (id: string) =>
      (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id)).key;
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(2);
    const noteKey = await key("note");
    const plannedKey = await key("planned");
    await expandDock(page, "now");
    const frame = nowFrame(page);
    await page
      .locator('[data-side-panel="now"]')
      .getByRole("button", { name: "Search tasks" })
      .click();
    const query = frame.locator("[data-now-query]");
    await expect(query).toBeFocused();

    // Typed from a Mac keyboard, what's new finds the release note's record.
    await query.pressSequentially("what's new");
    await expect(nowRow(page, noteKey)).toBeVisible();
    expect(await nowRowGroup(page, noteKey)).toBe("earlier");
    await expect(nowRow(page, plannedKey)).toHaveCount(0);

    await query.fill('"later"');
    await expect(nowRow(page, plannedKey)).toBeVisible();
    await expect(nowRow(page, noteKey)).toHaveCount(0);

    // Find on the task board reads a title the same way: the backlog task
    // is in the board's Backlog list.
    await openBoardButton(page).click();
    const find = boardEntry(page).locator("[data-board-find]");
    await clickInBody(find);
    await find.pressSequentially('"later"');
    await pressInBoard(boardViewTab(page, "backlog"));
    await expect(boardTile(page, plannedKey)).toBeVisible();
    await expect(boardEntry(page).locator("[data-board-tile]")).toHaveCount(1);
  } finally {
    await launched.close();
  }
});
