import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { pastEndingWords } from "../../src/shared/pastCard";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { settled } from "./layout";
import {
  expandDock,
  noteLines,
  nowFrame,
  pressRow,
  RECORD_FRAME_SELECTOR,
  recordFrame,
  showRecordTab,
} from "./rails";
import { expectNoCard, shownCard } from "./stack";

/**
 * The Cards row (FI3-579 piece 1): a closed task's record lists every card it
 * showed, newest first, each ending in words; a closed card opens as the
 * read-only past card through the shared show-card door, and a card still on
 * the stage is focused where it is. Nothing the row does writes anything.
 */

/** The live card the record's line focuses, and the one the captain closes with its cross. */
const TIDES_TITLE = "Tides noted";
const QUAY_TITLE = "Quay surveyed";

async function click(node: ReturnType<Page["locator"]>) {
  await node.evaluate((el) => (el as HTMLElement).click());
}

test("a closed task's record lists its cards newest first and opens one as the read-only past card", async () => {
  const userDataDir = scratchDir("infinitary-record-cards-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "cards-task",
    title: "Plan the harbour",
    status: "completed",
  });
  const store = new CardStore(db);
  const at = Date.now() - 3 * 3_600_000;
  const card = (
    id: string,
    title: string,
    createdAt: number,
    actions: { id: string; label: string }[],
  ) =>
    store.upsert({
      id,
      taskId: task.id,
      title,
      author: "firstmate",
      priority: 50,
      meta: "harbour",
      body: `<p>${title} body.</p>`,
      status: "ready",
      createdAt,
      actions,
    });
  const titles = {
    plan: "How to chart the harbour",
    merge: "Merge the harbour fix",
    note: "Soundings are in",
  };
  const build = { id: "build", label: "Approve and build" };
  card("plan", titles.plan, at, [{ id: "later", label: "Not now" }, build]);
  store.resolve("plan", build.id);
  card("merge", titles.merge, at + 1_000, [{ id: "merge", label: "Merge" }]);
  store.resolve("merge", "close");
  card("note", titles.note, at + 2_000, []);
  store.resolve("note", "close");
  tasks.close(task.id, { status: "done", reason: "answered", actor: "captain", text: "answered" });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await expandDock(page, "now");
    await click(nowFrame(page).locator('[data-now-group-header="landed"]'));
    await pressRow(page, task.key);
    const lines = recordFrame(page).locator("[data-record-card]");
    await showRecordTab(page, "cards");
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText(titles.note);
    await expect(lines.nth(0)).toContainText(pastEndingWords({ how: "dismissed", at }));
    await expect(lines.nth(1)).toContainText(titles.merge);
    await expect(lines.nth(2)).toContainText(titles.plan);
    await expect(lines.nth(2)).toContainText(
      pastEndingWords({ how: "chose", at, label: build.label }),
    );
    await settled(page, () => page.locator(RECORD_FRAME_SELECTOR).boundingBox());
    await page.screenshot({ path: test.info().outputPath("record-cards-row.png") });

    // The link takes the shared show-card door: the past card, read-only, nothing saved.
    const before = await page.evaluate(() => window.infinitary.tasks.detail("cards-task"));
    await click(lines.nth(2).locator("button"));
    const past = page.locator('[data-past-card="plan"]');
    await expect(past).toBeVisible();
    await expect(page.locator('[data-past-action="build"]')).toBeDisabled();
    await expect(page.locator('[data-past-action="build"]')).toHaveAttribute(
      "data-past-chosen",
      "",
    );
    expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
    expect((await page.evaluate(() => window.infinitary.tasks.detail("cards-task"))).cards).toEqual(
      before.cards,
    );
    await page.screenshot({ path: test.info().outputPath("record-cards-past.png") });
    // The row's press left the keyboard in the Tasks panel's page; a click on
    // the window outside every page gives the window the keys back.
    await page.mouse.click(20, 100);
    await expect(past).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(past).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

test("a card still on the stage reads On the stage and its link focuses the live card", async () => {
  const userDataDir = scratchDir("infinitary-record-cards-open-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "open-cards-task",
    title: "Chart the bay",
    status: "queued",
    startPolicy: "on-request",
  });
  const store = new CardStore(db);
  const now = Date.now();
  store.upsert({
    id: "bay-note",
    taskId: task.id,
    title: TIDES_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "bay",
    body: "<p>Tides are noted.</p>",
    status: "ready",
    createdAt: now,
    actions: [],
  });
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await expandDock(page, "now");
    await click(nowFrame(page).locator('[data-now-group-header="backlog"]'));
    await pressRow(page, task.key);
    await showRecordTab(page, "cards");
    const line = recordFrame(page).locator('[data-record-card="bay-note"]');
    // Its line says the card is on the stage; record.frame.test.ts owns the words it reads.
    await expect(line).toHaveAttribute("data-record-card-state", "open");
    await click(line.locator("button"));
    // The same live card, never a past copy.
    await expect(page.locator("[data-past-card]")).toHaveCount(0);
    await expect(shownCard(page, TIDES_TITLE)).toBeVisible();
  } finally {
    await launched.close();
  }
});

test("the cross on a card writes one line saying where it went, and the record lists it, its link a focusable button", async () => {
  const userDataDir = scratchDir("infinitary-record-cards-cross-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "cross-task",
    title: "Survey the quay",
    status: "queued",
    startPolicy: "on-request",
  });
  new CardStore(db).upsert({
    id: "quay-note",
    taskId: task.id,
    title: QUAY_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "quay",
    body: "<p>The quay is surveyed.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  });
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await expect(shownCard(page, QUAY_TITLE)).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expectNoCard(page, QUAY_TITLE);
    // One line names the card, on the record it stays on, so it carries that task's key (INF-1845).
    const said = noteLines(page, task.key).filter({ hasText: QUAY_TITLE });
    await expect(said).toHaveCount(1);

    await expandDock(page, "now");
    await click(nowFrame(page).locator('[data-now-group-header="backlog"]'));
    await pressRow(page, task.key);
    await showRecordTab(page, "cards");
    const line = recordFrame(page).locator('[data-record-card="quay-note"]');
    await expect(line).toContainText(pastEndingWords({ how: "dismissed", at: 0 }));
    // The title is a real, enabled button in the tab order, so Enter or Space presses it
    // (the hidden test window drops native focus, so focus itself is not asserted).
    await expect(line.locator("button")).toBeEnabled();
    expect(await line.locator("button").evaluate((el) => [el.tagName, el.tabIndex])).toEqual([
      "BUTTON",
      0,
    ]);
    await click(line.locator("button"));
    await expect(page.locator('[data-past-card="quay-note"]')).toBeVisible();
    // Opening it wrote no second line.
    await expect(said).toHaveCount(1);
  } finally {
    await launched.close();
  }
});
