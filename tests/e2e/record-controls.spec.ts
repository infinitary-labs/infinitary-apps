import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { Card } from "../../src/shared/cards";
import { RECORD_NEXT_LABELS } from "../../src/shared/recordBar";
import {
  DROP_CANCEL_LABEL,
  DROP_TASK_LABEL,
  DROPPED_BEFORE_START_ACTIVITY,
  dropConfirmLead,
  dropPartsRefusal,
  dropWaitingLine,
  NO_LONGER_WANTED,
} from "../../src/shared/recordDrop";
import type { TaskBoard } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { minimumWindowSize, resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  dockFrameElement,
  expandDock,
  expectRecordBar,
  expectRecordTaskStatus,
  hideRecord,
  nowFrame,
  nowRow,
  nowRowGroup,
  pressRow,
  recordBar,
  recordBarButton,
  recordCard,
  recordDrawings,
  recordFrame,
  reportLine,
  taskFact,
  taskKey,
  taskLine,
} from "./rails";
import { cardSurface, showCard, shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * The task record's action bar and the model chip (the captain's picks on
 * the task popup board, 2026-09-28: 4A and 1C; one bar, FI3-565 piece 4),
 * against the built app.
 *
 * The bar is the host's own row, read off typed state through the shared
 * `recordBarOf` (`expectRecordBar`): Drop task in the end slot in every open
 * state (one inline confirm that says whether unfinished work is kept), and
 * the next slot - Start on planned work (disabled while something blocks
 * it, which the body's attention box names), Continue on interrupted work,
 * Show the card while a decision card waits, nothing otherwise. Tab reaches
 * them in the order shown. Closed work has no bar.
 * The model is a fact in a record's readout (FI3-565 piece 2) and an outline
 * chip beside the meta line on a card's head, never truncated and never
 * pushed out, even at the narrowest window.
 *
 * The fixture is a record the app boots into: backlog rows on request (one
 * behind a blocker), and an idle crewmate with a decision card waiting and a
 * note beside it on the stack. Interrupted work is made the way the captain
 * meets it: a real crewmate's turn, and an app that quit while it was still
 * running - the next boot reads the row as interrupted.
 */

const LONG_MODEL = "a-very-long-model-name-that-must-stay-whole-9000";
const LONG_META =
  "A crewmate meta line long enough to crowd the card's head row, and then some more";
const DECISION_TITLE = "Which channel do we sound first?";
const NOTE_TITLE = "Harbour note";

function seeded(): string {
  const userDataDir = scratchDir("infinitary-record-controls-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const intent = (goal: string) => ({ goal, userWords: goal });
  let at = Date.now() - 60_000;
  const next = () => {
    at += 1_000;
    return at;
  };
  seedTask(tasks, {
    id: "rc-start",
    title: "Chart the harbour",
    intent: intent("Chart the harbour."),
    startPolicy: "on-request",
    status: "queued",
    createdAt: next(),
  });
  seedTask(tasks, {
    id: "rc-fail",
    title: "Sound the shoal",
    intent: intent("Sound the shoal."),
    startPolicy: "on-request",
    status: "queued",
    createdAt: next(),
  });
  seedTask(tasks, {
    id: "rc-first",
    title: "Survey the reef",
    intent: intent("Survey the reef."),
    startPolicy: "on-request",
    status: "queued",
    createdAt: next(),
  });
  seedTask(tasks, {
    id: "rc-blocked",
    title: "Sound the channel",
    intent: intent("Sound the channel."),
    startPolicy: "on-request",
    status: "queued",
    createdAt: next(),
  });
  tasks.link("rc-first", "rc-blocked", "blocks", "host");
  seedTask(tasks, {
    id: "rc-drop",
    title: "Fold the chart",
    intent: intent("Fold the chart."),
    startPolicy: "on-request",
    status: "queued",
    createdAt: next(),
  });
  seedTask(tasks, {
    id: "rc-waiter",
    title: "File the soundings",
    intent: intent("File the soundings."),
    startPolicy: "when-ready",
    status: "queued",
    createdAt: next(),
  });
  tasks.link("rc-drop", "rc-waiter", "blocks", "host");
  seedTask(tasks, {
    id: "rc-parent",
    title: "Survey the bay",
    intent: intent("Survey the bay."),
    startPolicy: "on-request",
    status: "queued",
    createdAt: next(),
  });
  seedTask(tasks, {
    id: "rc-part",
    title: "Mark the bar",
    intent: intent("Mark the bar."),
    parentId: "rc-parent",
    startPolicy: "on-request",
    status: "queued",
    createdAt: next(),
  });
  seedTask(tasks, {
    id: "rc-queued",
    title: "Sound at dawn",
    intent: intent("Sound at dawn."),
    startPolicy: "when-ready",
    status: "queued",
    gate: { kind: "at-time", until: Date.now() + 86_400_000 },
    createdAt: next(),
  });
  const decisionDir = join(userDataDir, "crew", "rc-decision");
  mkdirSync(decisionDir, { recursive: true });
  seedTask(tasks, {
    id: "rc-decision",
    title: "Pick a channel",
    intent: intent("Pick a channel."),
    status: "idle",
    worktreeDir: decisionDir,
    model: { provider: "fm-mock", id: LONG_MODEL },
    outcome: "Two channels look deep enough.",
    createdAt: next(),
  });
  const cards = new CardStore(db);
  const card = (fields: Partial<Card> & Pick<Card, "id" | "title">): Card => ({
    author: "crewmate",
    priority: 30,
    meta: "",
    body: "<p>Fixture card.</p>",
    actions: [],
    status: "ready",
    createdAt: next(),
    ...fields,
  });
  cards.upsert(
    card({
      id: "card-rc-decision-1",
      taskId: "rc-decision",
      title: DECISION_TITLE,
      meta: LONG_META,
      model: LONG_MODEL,
      actions: [
        { id: "east", label: "East first", variant: "secondary" },
        { id: "west", label: "West first", variant: "primary", default: true },
      ],
    }),
  );
  cards.upsert(
    card({ id: "card-rc-note", author: "firstmate", title: NOTE_TITLE, meta: "firstmate" }),
  );
  db.close();
  return userDataDir;
}

let launched: LaunchedApp;
let keys: Record<string, string>;
let userDataDir: string;

test.describe.configure({ mode: "serial" });

const INTERRUPTED_TITLE = "mend the sails";
let interruptedId: string;

test.beforeAll(async () => {
  userDataDir = seeded();
  // A real crewmate, with its session: commission it and let it report.
  const first = await launchApp({ userDataDir, withMockProvider: true });
  const input = promptInput(first.page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${INTERRUPTED_TITLE}`);
  await input.press("Enter");
  await expect(reportLine(first.page, await taskKey(first.page, INTERRUPTED_TITLE))).toBeVisible({
    timeout: 30_000,
  });
  const spawned: TaskBoard = await first.page.evaluate(() => window.infinitary.tasks.board());
  interruptedId = spawned.tasks.find((task) => task.title === INTERRUPTED_TITLE)?.id as string;
  await first.close();
  // The app quit while that crewmate's turn was still running.
  const db = openDatabase(userDataDir);
  new TaskService({ db, strict: true }).setActivity(interruptedId, "running");
  db.close();

  launched = await launchApp({ userDataDir, withMockProvider: true });
  const board: TaskBoard = await launched.page.evaluate(() => window.infinitary.tasks.board());
  keys = Object.fromEntries(board.tasks.map((task) => [task.id, task.key]));
  await expandDock(launched.page, "now");
  // Queued work starts by itself and always shows, like Working; the backlog
  // waits for the captain's word and sits behind its collapsed header.
  await expect(nowFrame(launched.page).locator('[data-now-group-header="queued"]')).toBeAttached({
    timeout: 30_000,
  });
  const backlog = nowFrame(launched.page).locator('[data-now-group-header="backlog"]');
  await expect(backlog).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 });
  await clickInFrame(backlog);
  await expect(backlog).toHaveAttribute("aria-expanded", "true");
});

test.afterAll(async () => {
  await launched.close();
});

const pane = (page: Page) => recordCard(page);
const footer = recordBar;
const end = (page: Page) => recordBarButton(page, "end");
const next = (page: Page) => recordBarButton(page, "next");

/** Chromium drops native clicks into a hidden window's sandboxed frames. */
async function clickInFrame(target: ReturnType<Page["locator"]>): Promise<void> {
  await target.evaluate((el) => (el as HTMLElement).click());
}

/** Open a task's record from its row in the Tasks panel. */
async function openRecord(page: Page, taskId: string): Promise<void> {
  await pressRow(page, keys[taskId] as string);
  await expect(pane(page)).toHaveAttribute("data-task-record", taskId);
  await expect(pane(page)).toHaveCSS("opacity", "1");
}

/**
 * Hide the shown record and wait until the stage draws it nowhere: the next
 * card can take a moment to get ready, and until then the record's drawing
 * stays, so opening it again in that moment would bring back that drawing
 * as it was, not the record afresh.
 */
async function closeRecord(page: Page): Promise<void> {
  const id = await pane(page).getAttribute("data-task-record");
  if (!id) throw new Error("No shown task record");
  await hideRecord(page).click();
  await expect(recordDrawings(page, id)).toHaveCount(0, { timeout: 15_000 });
}

/**
 * Drop task hides the record once the host accepts it; the task stays on its
 * record, which the Tasks panel's Open record shows again.
 */
async function reopenDropped(page: Page, taskId: string): Promise<void> {
  await expect(recordDrawings(page, taskId)).toHaveCount(0, { timeout: 15_000 });
  await openRecordFromPanel(page, taskId);
  await expect(pane(page)).toHaveAttribute("data-task-record", taskId);
}

test("a blocked planned task offers Start disabled and names what it waits on", async () => {
  const { page } = launched;
  await openRecord(page, "rc-blocked");
  expect(await expectRecordBar(page)).toMatchObject({ next: "start", blocked: true });
  await expect(next(page)).toBeDisabled();
  await expect(recordFrame(page).locator("[data-record-attention]")).toContainText(
    keys["rc-first"] as string,
  );
  await closeRecord(page);
});

test("Start starts a planned task on request and dismisses its record; Drop task on started work asks once, inline, then ends it", async () => {
  const { page } = launched;
  await openRecord(page, "rc-start");
  await expectRecordTaskStatus(page);
  expect(await expectRecordBar(page)).toMatchObject({ end: "drop-task", next: "start" });
  // Drop task holds the end slot; Start is the next slot's primary that begins the work.
  await expect(end(page)).toHaveAccessibleName(DROP_TASK_LABEL);
  await expect(next(page)).toHaveAccessibleName(RECORD_NEXT_LABELS.start);
  await expect(recordFrame(page).locator('[data-record-section="words"]')).toBeVisible();
  // Tab reaches them in the order shown: Drop task, then Start.
  await pressKey(end(page), "Tab");
  await expect(next(page)).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("record-start.png") });
  await next(page).click();

  // The record leaves once the start is accepted; the crewmate then begins.
  await expect(page.locator('[data-task-record="rc-start"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(nowRow(page, keys["rc-start"] as string)).not.toHaveAttribute("data-now-selected");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.infinitary.tasks.detail("rc-start").then((task) => ({
            status: task.status,
            dispatched: task.events.some((event) => event.kind === "dispatched"),
          })),
        ),
      { timeout: 30_000 },
    )
    .toEqual({ status: "active", dispatched: true });
  await expect.poll(() => nowRowGroup(page, keys["rc-start"] as string)).toBe("working");
  await page.screenshot({ path: test.info().outputPath("record-start-dismissed.png") });

  // Reopened from its row, the started task's record still ends with Drop task.
  await openRecord(page, "rc-start");
  await expect(footer(page)).toHaveAttribute("data-record-end", "stop-task", { timeout: 30_000 });
  await expectRecordBar(page);
  await expect(end(page)).toHaveAccessibleName(DROP_TASK_LABEL);

  // Drop task asks first, in the row itself, saying its unfinished work is
  // kept; Cancel takes the end slot and puts the row back.
  await end(page).click();
  await expect(footer(page)).toHaveAttribute("data-record-footer", "confirm");
  await expect(footer(page).locator("[data-record-confirm]")).toHaveText(
    dropConfirmLead(keys["rc-start"] as string, true),
  );
  await expect(end(page)).toHaveAccessibleName(DROP_CANCEL_LABEL);
  await expect(end(page)).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("record-drop-started-confirm.png") });
  await end(page).click();
  await expect(footer(page)).toHaveAttribute("data-record-footer", "bar");
  await expect(
    page.evaluate(() => window.infinitary.tasks.detail("rc-start").then((task) => task.status)),
  ).resolves.toBe("active");

  // A second click on the same spot cancels; the confirm sits in the next slot.
  await end(page).click();
  await next(page).click();
  // Dropped: the record leaves once the drop is accepted, and opened again
  // it reads the task closed as cancelled.
  await reopenDropped(page, "rc-start");
  await expectRecordTaskStatus(page);
  await expectRecordBar(page);
  const stopped = await page.evaluate(() => window.infinitary.tasks.detail("rc-start"));
  expect(stopped).toMatchObject({ status: "dropped", closedReason: "cancelled" });
  await closeRecord(page);
});

test("interrupted work reads in danger and offers Continue beside Drop task; Continue carries on", async () => {
  const { page } = launched;
  await openRecord(page, interruptedId);
  await expect(pane(page).locator("[data-record-status]")).toHaveAttribute(
    "data-record-status",
    "danger",
  );
  await expectRecordTaskStatus(page);
  expect(await expectRecordBar(page)).toMatchObject({ end: "stop-task", next: "continue" });
  // Continue is the next slot's one primary, after Drop task.
  await expect(end(page)).toHaveAccessibleName(DROP_TASK_LABEL);
  await expect(next(page)).toHaveAccessibleName(RECORD_NEXT_LABELS.continue);
  await page.screenshot({ path: test.info().outputPath("record-interrupted.png") });
  await next(page).click();

  // The captain's word reached the crewmate, and it is no longer interrupted.
  await expect(footer(page)).toHaveAttribute("data-record-next", "none", { timeout: 30_000 });
  await expectRecordBar(page);
  const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), interruptedId);
  expect(detail.activity).not.toBe("interrupted");
  expect(detail.events.filter((event) => event.kind === "steered").at(-1)?.actor).toBe("captain");
  await closeRecord(page);
});

/**
 * Opens a task's record with the panel API's Open record, as the task
 * board's menu does, from the Tasks panel's page while it holds the keys:
 * the record opens even while the task's decision card waits elsewhere.
 */
async function openRecordFromPanel(page: Page, taskId: string): Promise<void> {
  await expandDock(page, "now");
  await focusOn(dockFrameElement(page, "now"));
  await nowFrame(page)
    .locator("body")
    .evaluate(
      (_body, id) =>
        (
          window as unknown as { inf: { action: (id: string, value: unknown) => Promise<unknown> } }
        ).inf.action("point.openRecord", { taskId: id }),
      taskId,
    );
}

test("while a decision card waits the bar keeps Drop task, and Show the card brings it forward", async () => {
  const { page } = launched;
  // Page the stack away from the decision.
  await showCard(page, NOTE_TITLE);
  await expect(shownCard(page, DECISION_TITLE)).toHaveCount(0);
  // The record is open when the card is elsewhere - here opened by the
  // panel API's Open record, as the task board's menu opens it, with the
  // Tasks panel's page holding the keys (a row click would bring the card
  // forward first).
  await openRecordFromPanel(page, "rc-decision");
  await expect(pane(page)).toHaveAttribute("data-task-record", "rc-decision");
  await expect(pane(page).locator("[data-record-status]")).toHaveAttribute(
    "data-record-status",
    "accent",
  );
  expect(await expectRecordBar(page)).toMatchObject({ end: "stop-task", next: "show-card" });
  await expect(end(page)).toHaveAccessibleName(DROP_TASK_LABEL);
  await expect(next(page)).toHaveAccessibleName(RECORD_NEXT_LABELS["show-card"]);
  await page.screenshot({ path: test.info().outputPath("record-waiting.png") });
  await next(page).click();
  await expect(shownCard(page, DECISION_TITLE)).toBeVisible();
  // It pages and writes nothing: the record remains open but is not shown.
  await expect(pane(page)).toHaveCount(0);
  await expect(nowFrame(page).locator('[data-now-row="rc-decision"]')).toHaveAttribute(
    "data-now-selected",
    "",
  );
  const board: TaskBoard = await page.evaluate(() => window.infinitary.tasks.board());
  expect(board.tasks.find((task) => task.id === "rc-decision")?.waitingCardId).toBe(
    "card-rc-decision-1",
  );
});

test("Drop task asks once, then hides the record, keeps the task on it and leaves the backlog", async () => {
  mkdirSync(test.info().outputPath("drop-task"), { recursive: true });
  const { page } = launched;
  await openRecord(page, "rc-drop");
  expect(await expectRecordBar(page)).toMatchObject({ end: "drop-task", next: "start" });
  await expect(end(page)).toHaveAccessibleName(DROP_TASK_LABEL);
  await page.screenshot({ path: test.info().outputPath("drop-task/footer.png") });

  await end(page).click();
  await expect(footer(page)).toHaveAttribute("data-record-footer", "confirm");
  await expect(footer(page).locator("[data-record-confirm]")).toHaveAttribute(
    "data-record-confirm",
    "drop-task",
  );
  const waiting = dropWaitingLine([{ key: keys["rc-waiter"] as string }]);
  await expect(footer(page)).toContainText(dropConfirmLead(keys["rc-drop"] as string));
  if (waiting) await expect(footer(page)).toContainText(waiting);
  await expect(footer(page).getByRole("button", { name: DROP_CANCEL_LABEL })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("drop-task/confirm.png") });

  await page.keyboard.press("Enter");
  await expect(footer(page)).toHaveAttribute("data-record-footer", "bar");
  await expect(
    page.evaluate(() => window.infinitary.tasks.detail("rc-drop").then((task) => task.status)),
  ).resolves.toBe("open");

  // Hidden while it asks: nothing is dropped, and the record met again is
  // afresh, its bar at rest.
  await footer(page).getByRole("button", { name: DROP_TASK_LABEL }).click();
  await expect(footer(page)).toHaveAttribute("data-record-footer", "confirm");
  await closeRecord(page);
  await expect(
    page.evaluate(() => window.infinitary.tasks.detail("rc-drop").then((task) => task.status)),
  ).resolves.toBe("open");

  await openRecord(page, "rc-drop");
  expect(await expectRecordBar(page)).toMatchObject({ end: "drop-task", next: "start" });
  await end(page).click();
  await next(page).click();
  await reopenDropped(page, "rc-drop");
  await expectRecordTaskStatus(page);
  await expectRecordBar(page);
  await expect(recordFrame(page).locator("[data-record-context]")).toContainText(NO_LONGER_WANTED);
  await recordFrame(page)
    .locator('[data-record-section="timeline"] > summary')
    .evaluate((el) => (el as HTMLElement).click());
  await expect(recordFrame(page).locator('[data-record-event="status"]')).toContainText(
    DROPPED_BEFORE_START_ACTIVITY,
  );
  await page.screenshot({ path: test.info().outputPath("drop-task/retained.png") });

  const dropped = await page.evaluate(() => window.infinitary.tasks.detail("rc-drop"));
  expect(dropped).toMatchObject({ status: "dropped", closedReason: "cancelled" });
  expect(dropped.events.filter((event) => event.kind === "status")).toHaveLength(1);
  expect(dropped.events.at(-1)?.actor).toBe("captain");
  const after = await page.evaluate(() =>
    Promise.all([
      window.infinitary.tasks.detail("rc-waiter"),
      window.infinitary.tasks.board(),
    ]).then(([waiter, board]) => ({
      waiter,
      linked: board.links.some(
        (link) => link.fromId === "rc-drop" && link.toId === "rc-waiter" && link.type === "blocks",
      ),
    })),
  );
  expect(after.waiter.status).toBe("open");
  expect(after.waiter.flags.ready).toBe(false);
  expect(after.linked).toBe(true);
  await expect(nowRow(page, keys["rc-drop"] as string)).toHaveCount(0);
  expect(dropped.status).not.toBe("done");
  await closeRecord(page);
});

test("a blocked backlog task can be dropped, and a parent with an open part cannot", async () => {
  const { page } = launched;
  await openRecord(page, "rc-blocked");
  await expect(next(page)).toBeDisabled();
  await expect(end(page)).toBeEnabled();
  await end(page).click();
  await next(page).click();
  await reopenDropped(page, "rc-blocked");
  await expectRecordTaskStatus(page);
  await closeRecord(page);

  // A parent's parts do the work: Drop task with an empty next slot.
  await openRecord(page, "rc-parent");
  expect(await expectRecordBar(page)).toMatchObject({ end: "drop-task", next: null });
  await end(page).click();
  const partKey = keys["rc-part"] as string;
  await expect(pane(page).getByRole("alert")).toContainText(
    dropPartsRefusal(keys["rc-parent"] as string, [{ key: partKey, title: "Mark the bar" }]),
  );
  await expect(
    page.evaluate(() =>
      Promise.all([
        window.infinitary.tasks.detail("rc-parent"),
        window.infinitary.tasks.detail("rc-part"),
      ]).then(([parent, part]) => [parent.status, part.status]),
    ),
  ).resolves.toEqual(["open", "open"]);
  await closeRecord(page);

  // Queued work starts by itself: Drop task, and no Start now.
  await openRecord(page, "rc-queued");
  expect(await expectRecordBar(page)).toMatchObject({ end: "drop-task", next: null });
  await page.screenshot({ path: test.info().outputPath("record-queued.png") });
  await closeRecord(page);
});

/** The chip shows every character of the model's name: inside it, nothing scrolls out of view. */
const readsWhole = (chip: Locator) =>
  chip.evaluate((el) =>
    [el, ...el.querySelectorAll("*")].every(
      (node) =>
        node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
    ),
  );

test("at the narrowest window the model a task ran on reads whole, on its record and on its card", async () => {
  const { page, app } = launched;
  const before = await resizeWindow(app, page, await minimumWindowSize(app));
  await openRecordFromPanel(page, "rc-decision");
  await expect(pane(page)).toHaveAttribute("data-task-record", "rc-decision");
  const recordModel = taskFact(pane(page), "model");
  await expect(recordModel).toHaveText(LONG_MODEL);
  await expect(recordModel).toBeInViewport({ ratio: 1 });
  expect(await readsWhole(recordModel)).toBe(true);

  await showCard(page, DECISION_TITLE);
  const cardChip = cardSurface(page).locator("[data-model-chip]");
  await expect(cardChip).toContainText(LONG_MODEL);
  await expect(cardChip).toBeInViewport({ ratio: 1 });
  expect(await readsWhole(cardChip)).toBe(true);
  await resizeWindow(app, page, before);
});

test("at the narrowest window Drop task still asks once and drops the task", async () => {
  const { page, app } = launched;
  await openRecord(page, "rc-queued");
  await end(page).click();
  await expect(footer(page)).toHaveAttribute("data-record-footer", "confirm");
  const before = await resizeWindow(app, page, await minimumWindowSize(app));
  await page.screenshot({ path: test.info().outputPath("record-narrow-confirm.png") });
  await next(page).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.infinitary.tasks.detail("rc-queued").then((task) => task.status)),
    )
    .toBe("dropped");
  await resizeWindow(app, page, before);
});

test("a Start that fails after it was accepted hides its record at once, and the failure still reaches the captain", async () => {
  const { page } = launched;
  const key = keys["rc-fail"] as string;
  // A repository on another branch stands where the task's working copy
  // goes, so the host accepts the start and it fails making that copy.
  const inTheWay = join(userDataDir, "worktrees", "rc-fail");
  mkdirSync(inTheWay, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=elsewhere"], {
    cwd: inTheWay,
    stdio: "pipe",
  });
  await openRecord(page, "rc-fail");
  expect(await expectRecordBar(page)).toMatchObject({ end: "drop-task", next: "start" });
  await next(page).click();

  // The record leaves on acceptance: it does not wait for an outcome, and
  // this start never has a crewmate begin.
  await expect(recordDrawings(page, "rc-fail")).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.infinitary.tasks.detail("rc-fail").then((task) => ({
            status: task.status,
            starting: task.startAttempt !== undefined,
          })),
        ),
      { timeout: 30_000 },
    )
    .toEqual({ status: "open", starting: false });

  // The failure still reaches the captain: the task's own line in the feed,
  // its row back in the backlog, and its record, opened again, offers the
  // start once more.
  await expect(taskLine(page, key, "note")).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => nowRowGroup(page, key)).toBe("backlog");
  await openRecord(page, "rc-fail");
  await expectRecordTaskStatus(page);
  expect(["start", "try-again"]).toContain((await expectRecordBar(page))?.next);
  await page.screenshot({ path: test.info().outputPath("record-start-failed.png") });
  await closeRecord(page);
});
