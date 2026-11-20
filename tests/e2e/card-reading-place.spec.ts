import { expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { expandDock, nowFrame, pressRow, recordCard, recordFrame, showRecordTab } from "./rails";
import { cardScroller, showCard, shownCard, shownEntry, stageAtRest } from "./stack";

const checks = [
  "Read the release notes against the changes people will see.",
  "Check the launch window and keep the review beside it.",
  "Confirm every supported computer can get the new version.",
  "Try the card controls with the keyboard before publishing.",
  "Check the saved data with a disposable profile before updating.",
  "Keep the previous version available until the review is complete.",
  "Confirm the checks passed on the version being published.",
  "Read each screenshot and make sure its caption describes it.",
  "Keep the release highlights in the order the captain chose.",
  "Confirm the new version opens its release notes on first launch.",
  "Make sure unfinished work is named before offering the merge.",
  "Check the download on a second computer before finishing.",
];
/** How far one wheel turn asks a card's body to scroll. */
const WHEEL_TURN = 400;

/**
 * A body of four sections, about 1,500px tall: more than the 800px default
 * window and a wheel turn together, so the turn stops mid-body however much
 * of that window the stage gives the card. Two sections were about 770px,
 * which stopped overflowing by a turn once a short window gave the card the
 * stage's empty space (docs/renderer.md, "Short windows").
 */
const long = (heading: string) =>
  [heading, "During", "After", "Later"]
    .map((h) => `<h2>${h}</h2>${checks.map((c) => `<p>${c}</p>`).join("")}`)
    .join("");

/**
 * Scrolls like a person, a wheel turn over the body rather than a scrollTop
 * write, and returns the reading place once that scroll has ended: the body
 * says so with its own scrollend, however long a busy computer takes to play
 * the scroll out.
 */
async function wheelToRest(page: Page, scroller: Locator): Promise<number> {
  const box = await scroller.boundingBox();
  if (!box) throw new Error("no body box");
  // Wrapped in an object: a handle to a bare promise would wait for it to
  // settle, before the wheel has turned.
  const ended = await scroller.evaluateHandle((el) => ({
    top: new Promise<number>((resolve) =>
      el.addEventListener("scrollend", () => resolve(el.scrollTop), { once: true }),
    ),
  }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, WHEEL_TURN);
  const top = await page.evaluate((scrolled) => scrolled.top, ended);
  expect(top).toBeGreaterThan(0);
  return top;
}

/**
 * Paging back restores the place once the card's body can hold it; it is the
 * reading place still once the stage has finished every move the paging
 * started and drawn the card at rest, where the captain reads on.
 */
async function expectPlaceKept(page: Page, scroller: () => Locator, top: number): Promise<void> {
  await expect.poll(() => scroller().evaluate((el) => el.scrollTop)).toBe(top);
  await stageAtRest(page);
  expect(await scroller().evaluate((el) => el.scrollTop)).toBe(top);
}

// INF-513: the captain lost a card's scroll offset by paging away and back.
test("paging away from a live card and back keeps its reading place", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-scroll-repro-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  const now = Date.now();
  store.upsert({
    id: "read-a",
    title: "Read review A",
    author: "firstmate",
    meta: "firstmate",
    body: long("Review A"),
    actions: [],
    status: "ready",
    priority: 20,
    createdAt: now - 2000,
  });
  store.upsert({
    id: "read-b",
    title: "Read review B",
    author: "firstmate",
    meta: "firstmate",
    body: long("Review B"),
    actions: [],
    status: "ready",
    priority: 20,
    createdAt: now - 1000,
  });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await showCard(page, "Read review A");
    const body = () => cardScroller(page);
    await expect.poll(() => body().evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const top = await wheelToRest(page, body());
    await page.getByRole("button", { name: "Next card" }).click();
    await expect(shownCard(page, "Read review B")).toBeVisible();
    await stageAtRest(page);
    await page.getByRole("button", { name: "Previous card" }).click();
    await expect(shownCard(page, "Read review A")).toBeVisible();
    await expectPlaceKept(page, body, top);
  } finally {
    await launched.close();
  }
});

test("paging away from a task record and back keeps its reading place", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-scroll-record-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const words = (what: string) =>
    Array.from(
      { length: 70 },
      (_, i) => `${i + 1}. Read all the ${what} soundings in this record.`,
    ).join("\n\n");
  const a = seedTask(tasks, {
    id: "scroll-a",
    title: "Chart the harbour",
    status: "queued",
    startPolicy: "on-request",
    intent: { goal: "Keep the harbour chart readable.", userWords: words("harbour") },
  });
  const b = seedTask(tasks, {
    id: "scroll-b",
    title: "Chart the river",
    status: "queued",
    startPolicy: "on-request",
    intent: { goal: "Keep the river chart readable.", userWords: words("river") },
  });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="backlog"]')
      .evaluate((el) => (el as HTMLElement).click());
    await pressRow(page, a.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", a.id);
    // The record appears once its body frame has drawn, and until then it is
    // unseen and takes no pointer (docs/renderer.md). Opened before then, its
    // words push that frame out of view, where the Mac does not draw it, so
    // the record appears only when its hold ends and a wheel turn meanwhile
    // scrolls nothing. The captain opens the words on the record they see.
    await expect(shownEntry(page)).toHaveCSS("opacity", "1");
    await recordCard(page)
      .locator('[data-record-section="words"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    const scroller = () => recordCard(page).locator("[data-card-body]");
    await expect
      .poll(() =>
        scroller().evaluate((el, turn) => el.scrollHeight - el.clientHeight > turn, WHEEL_TURN),
      )
      .toBe(true);
    // The open words grow the card: the captain scrolls it once it has come
    // to rest (docs/e2e-contracts.md).
    await stageAtRest(page);
    const top = await wheelToRest(page, scroller());
    await pressRow(page, b.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", b.id);
    await stageAtRest(page);
    const toA = (await page.getByRole("button", { name: "Next card" }).isEnabled())
      ? "Next card"
      : "Previous card";
    await page.getByRole("button", { name: toA }).click();
    await expect(recordCard(page)).toHaveAttribute("data-task-record", a.id);
    await expectPlaceKept(page, scroller, top);
  } finally {
    await launched.close();
  }
});

test("paging away from a past card and back keeps its reading place", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-scroll-past-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, { id: "past-task", title: "Plan the harbour", status: "completed" });
  const store = new CardStore(db);
  store.upsert({
    id: "past-long",
    taskId: task.id,
    title: "Long past review",
    author: "firstmate",
    priority: 50,
    meta: "harbour",
    body: long("Past review"),
    status: "ready",
    createdAt: Date.now() - 3_600_000,
    actions: [],
  });
  store.resolve("past-long", "close");
  tasks.close(task.id, { status: "done", reason: "answered", actor: "captain", text: "answered" });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="landed"]')
      .evaluate((el) => (el as HTMLElement).click());
    await pressRow(page, task.key);
    await showRecordTab(page, "cards");
    await recordFrame(page)
      .locator("[data-record-card] button")
      .first()
      .evaluate((el) => (el as HTMLElement).click());
    const past = page.locator('[data-past-card="past-long"]');
    await expect(past).toBeVisible();
    // Playwright reads it as visible at opacity 0: until its body draws, the
    // stage keeps the record's drawing in front of it behind a shield, which
    // takes a wheel turn aimed at the past card even once its body can scroll
    // (docs/e2e-contracts.md). The captain scrolls it once it has come to rest.
    await stageAtRest(page);
    const scroller = () => cardScroller(page);
    await expect
      .poll(() =>
        scroller().evaluate((el, turn) => el.scrollHeight - el.clientHeight > turn, WHEEL_TURN),
      )
      .toBe(true);
    const top = await wheelToRest(page, scroller());
    const away = (await page.getByRole("button", { name: "Next card" }).isEnabled())
      ? "Next card"
      : "Previous card";
    const back = away === "Next card" ? "Previous card" : "Next card";
    await page.getByRole("button", { name: away }).click();
    await expect(past).toHaveCount(0);
    await stageAtRest(page);
    await page.getByRole("button", { name: back }).click();
    await expect(past).toBeVisible();
    await expectPlaceKept(page, scroller, top);
  } finally {
    await launched.close();
  }
});
