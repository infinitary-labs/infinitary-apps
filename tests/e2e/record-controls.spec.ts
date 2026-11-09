import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  FRAME_WATCHDOG_INTERVAL_MS,
  FRAME_WATCHDOG_MISSES,
} from "../../src/renderer/src/plugins/frames/frameController";
import type { Card } from "../../src/shared/cards";
import { RECORD_NEXT_LABELS } from "../../src/shared/recordBar";
import {
  DROP_CANCEL_LABEL,
  DROP_TASK_LABEL,
  DROPPED_BEFORE_START_ACTIVITY,
  dropConfirmLead,
  dropPartsLine,
  dropWaitingLine,
  NO_LONGER_WANTED,
} from "../../src/shared/recordDrop";
import type { TaskBoard } from "../../src/shared/tasks";
import { recordAttentionWaits, taskWaitText } from "../../src/shared/taskWaits";
import { scratchDir } from "../helpers/scratchDirs";
import { nextFrame } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { atRest, minimumWindowSize, resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  dockFrameElement,
  expandDock,
  expectRecordBar,
  expectRecordBody,
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
  showRecordTab,
  taskFact,
  taskKey,
  taskLine,
} from "./rails";
import { cardSurface, showCard, shownCard, shownEntry } from "./stack";
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
 * them in the order shown. Closed work has no bar. A press on the bar lands
 * on its control even when the record grows under it (INF-204).
 * The model is a fact in a record's readout (FI3-565 piece 2) and an outline
 * chip beside the meta line on a card's head, never truncated and never
 * pushed out, even at the narrowest window. On the record it sits in the row
 * of facts that scrolls with the Info body (INF-2261), so it reads whole once
 * the body is scrolled to it.
 *
 * The fixture is a record the app boots into: backlog rows on request (one
 * behind a blocker, one a crewmate filed), and an idle crewmate with a
 * decision card waiting and a note beside it on the stack. Interrupted work is made the way the captain
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
  tasks.graph.link("rc-first", "rc-blocked", "blocks", "host");
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
  tasks.graph.link("rc-drop", "rc-waiter", "blocks", "host");
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
  // A follow-up its crewmate filed, as file_followup does: its record leads
  // with why it was filed, so its body draws taller than the card's floor.
  tasks.fileFollowup({
    id: "rc-press",
    originId: "rc-decision",
    title: "Coil the mooring lines",
    goal: "The mooring lines are coiled, dried and stowed in the forward locker.",
    prompt: "",
    why: "While sounding the channel I found the mooring lines left wet on deck since the last tide. Wet lines stiffen in the locker, and the next crew to need them finds them short. Coiling them is not part of picking a channel, so I left them as they are.",
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
  new TaskService({ db, strict: true }).turns.setActivity(interruptedId, "running");
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
  await expectRecordBody(page);
}

/**
 * Hide the shown record and wait until the stage draws it nowhere: the next
 * card can take a moment to get ready, and until then the record's drawing
 * stays as it drops away.
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
  await expect(recordCard(page).locator("[data-record-attention]")).toContainText(
    keys["rc-first"] as string,
  );
  await closeRecord(page);
});

test("Start starts a planned task on request and dismisses its record; Drop task on started work asks once, inline, then ends it", async () => {
  const { page } = launched;
  await openRecord(page, "rc-start");
  await expectRecordTaskStatus(page);
  // INF-2362: Backlog's wait moved from the mark to the attention box,
  // not out of the record. Keep the full words check at that owner.
  const planned = await page.evaluate(() => window.infinitary.tasks.detail("rc-start"));
  const waits = recordAttentionWaits(planned);
  expect(waits).toHaveLength(1);
  expect(waits[0]?.kind).toBe("backlog");
  const attention = recordCard(page).locator("[data-record-attention-title]");
  await expect(attention).toHaveText(
    waits.map((wait) => taskWaitText(wait, Date.now())).join("; "),
  );
  await test.info().attach("backlog-wait-ownership", {
    body: JSON.stringify({
      waits,
      attention: await attention.innerText(),
      mark: await pane(page).locator("[data-task-mark]").getAttribute("aria-label"),
    }),
    contentType: "application/json",
  });
  expect(await expectRecordBar(page)).toMatchObject({ end: "drop-task", next: "start" });
  // Drop task holds the end slot; Start is the next slot's primary that begins the work.
  await expect(end(page)).toHaveAccessibleName(DROP_TASK_LABEL);
  await expect(next(page)).toHaveAccessibleName(RECORD_NEXT_LABELS.start);
  await expect(recordCard(page).locator("[data-record-goal]")).toBeVisible();
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

  // INF-2314: queued guidance hides Continue before the saved conversation
  // reopens. Await the actual continuation, not just the changed footer:
  // the captain's word reached the crewmate, and it is no longer interrupted.
  await expect(footer(page)).toHaveAttribute("data-record-next", "none", { timeout: 30_000 });
  await expectRecordBar(page);
  const observations: unknown[] = [];
  await expect
    .poll(
      async () => {
        const detail = await page.evaluate(
          (id) => window.infinitary.tasks.detail(id),
          interruptedId,
        );
        const steer = detail.events.filter((event) => event.kind === "steered").at(-1);
        observations.push({ activity: detail.activity, posture: detail.workPosture, steer });
        return { interrupted: detail.activity === "interrupted", actor: steer?.actor };
      },
      { timeout: 30_000 },
    )
    .toEqual({ interrupted: false, actor: "captain" });
  await test.info().attach("continued-task", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
  await closeRecord(page);
});

/**
 * Opens a task's record with the panel API's Open record, as the task
 * board's menu does, from the Tasks panel's page while it holds the keys:
 * the record opens even while the task's decision card waits elsewhere.
 * The panel must be in sight: folded rails hide it and take its keys away.
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
  await expect(pane(page)).toHaveAttribute("data-task-record", taskId);
  await expectRecordBody(page);
}

/**
 * How long a card or a record whose body frame has not drawn stays unseen
 * before it appears as it is: the stage's hold, the frame watchdog's budget
 * (`HOLD_LIMIT_MS`, FRAME_WATCHDOG_INTERVAL_MS x FRAME_WATCHDOG_MISSES),
 * plus slack. `HOLD_LIMIT_MS` is not exported (`CardLayer.tsx`), so its
 * product is taken from the watchdog constants it is made of.
 */
const HOLD_WINDOW_MS = FRAME_WATCHDOG_INTERVAL_MS * FRAME_WATCHDOG_MISSES + 3_000;

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
  // It appears once its body has drawn, and only then takes the window's
  // focus (`focusCard`); until then the record it replaces stays in sight.
  // The test ends once it has appeared: a card still to appear would take
  // the focus the next test's row press gives the Tasks panel before its
  // click counts, and no record would open (INF-697, as INF-532).
  await expect(shownEntry(page)).toHaveCSS("opacity", "1", { timeout: HOLD_WINDOW_MS });
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

/**
 * Holds every mount of a record's body frame (`inf:frames:mount`) until the
 * returned release, which serves them and puts the app's own handler back:
 * the record waits for its body to draw (INF-510) and, when its hold ends
 * with the body still unable to load, appears as it is (FI3-948), so a press
 * goes down before that frame draws and grows the card, in order, never by
 * timing it. Every other frame mounts as usual.
 */
async function holdRecordBodies(app: ElectronApplication): Promise<() => Promise<void>> {
  await app.evaluate(({ ipcMain }) => {
    const channel = "inf:frames:mount";
    const handlers = (
      ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
      }
    )._invokeHandlers;
    const mount = handlers.get(channel);
    if (!mount) throw new Error("Frame mount handler missing");
    const held: (() => void)[] = [];
    (globalThis as typeof globalThis & { releaseRecordBodies?: () => void }).releaseRecordBodies =
      () => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, mount);
        for (const serve of held.splice(0)) serve();
      };
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      // The record's template, by the hook its body paints into.
      const html = (args[0] as { template?: { html?: unknown } } | undefined)?.template?.html;
      if (typeof html === "string" && html.includes("data-record-content"))
        await new Promise<void>((resolve) => held.push(resolve));
      return mount(event, ...args);
    });
  });
  return () =>
    app.evaluate(() =>
      (
        globalThis as typeof globalThis & { releaseRecordBodies?: () => void }
      ).releaseRecordBodies?.(),
    );
}

test("a press on the bar that goes down before the record's body draws lands on its control", async () => {
  // INF-204: a record whose body frame has not drawn when its hold ends
  // appears without it, and that frame then grows the card at once, with no
  // easing. The card holds still under the press, as it does while it eases,
  // so the release lands where the press went down; then the card settles at
  // its grown height.
  const { app, page } = launched;
  const serveBodies = await holdRecordBodies(app);
  let down = false;
  try {
    await pressRow(page, keys["rc-press"] as string);
    await expect(pane(page)).toHaveAttribute("data-task-record", "rc-press");
    // It appears, its body still pending, once its hold ends: until then the
    // card it replaces stays in sight and takes the press.
    await expect(shownEntry(page)).toHaveCSS("opacity", "1", { timeout: HOLD_WINDOW_MS });
    const body = pane(page).locator("[data-record-body]");
    await expect(body.locator("[data-frame-mount-pending]")).toBeVisible();
    await expect(end(page)).toHaveAccessibleName(DROP_TASK_LABEL);
    // The press goes where the revealed card rests.
    await atRest(end(page));
    const drop = await end(page).boundingBox();
    const pending = await body.boundingBox();
    const card = await cardSurface(page).boundingBox();
    if (!drop || !pending || !card) throw new Error("The record is not on screen");
    await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2);
    await page.mouse.down();
    down = true;
    await serveBodies();
    await expectRecordBody(page);
    // The size watcher has heard the drawn frame: it reads before the paint after it.
    await nextFrame(page);
    expect((await body.boundingBox())?.height).toBeGreaterThan(pending.height);
    await page.mouse.up();
    down = false;
    await expect(footer(page)).toHaveAttribute("data-record-footer", "confirm");
    // Released, the card takes the room its drawn body needs.
    await expect
      .poll(async () => (await cardSurface(page).boundingBox())?.height)
      .toBeGreaterThan(card.height);
    await closeRecord(page);
    await expect(
      page.evaluate(() => window.infinitary.tasks.detail("rc-press").then((task) => task.status)),
    ).resolves.toBe("open");
  } finally {
    if (down) await page.mouse.up();
    await serveBodies();
  }
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
  await expect(recordCard(page).locator("[data-record-context]")).toContainText(NO_LONGER_WANTED);
  await showRecordTab(page, "activity");
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

test("a blocked backlog task can be dropped, and so can a parent, whose open part stays planned", async () => {
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
  // INF-3169's one drop: the question names the part that stays planned,
  // and the drop goes through.
  const partKey = keys["rc-part"] as string;
  await expect(footer(page)).toHaveAttribute("data-record-footer", "confirm");
  await expect(footer(page)).toContainText(
    dropPartsLine([{ key: partKey, title: "Mark the bar" }]) as string,
  );
  await page.screenshot({ path: test.info().outputPath("drop-parent-confirm.png") });
  await next(page).click();
  await reopenDropped(page, "rc-parent");
  await expect(
    page.evaluate(() =>
      Promise.all([
        window.infinitary.tasks.detail("rc-parent"),
        window.infinitary.tasks.detail("rc-part"),
      ]).then(([parent, part]) => [parent.status, part.status]),
    ),
  ).resolves.toEqual(["dropped", "open"]);
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

/**
 * Scroll the record's body until the fact sits in the middle of its sight,
 * the way a person scrolls down to the row of facts: at the narrowest window
 * the body is shorter than its Info rows, and the row scrolls with the body
 * (INF-2261, the captain's pick: "At the end of the Info body, under a
 * hairline, scrolling with it"). Where the body rests depends on where it was
 * left, so a check of the row must not read it there. Only up and down: a
 * name pushed out sideways stays out of sight.
 */
async function scrollRecordBodyTo(fact: Locator): Promise<void> {
  await fact.evaluate((el) => {
    const body = el.closest<HTMLElement>("[data-card-body]");
    if (!body) throw new Error("The fact is not inside the record's body");
    const at = el.getBoundingClientRect();
    const sight = body.getBoundingClientRect();
    body.scrollTop += at.top + at.height / 2 - (sight.top + body.clientHeight / 2);
  });
}

test("at the narrowest window the model a task ran on reads whole, on its record and on its card", async () => {
  const { page, app } = launched;
  // The record opens before the window narrows: at the narrowest window the
  // rails fold and hide the Tasks panel, whose page then loses the keys
  // Open record answers to (INF-647).
  await openRecordFromPanel(page, "rc-decision");
  const before = await resizeWindow(app, page, await minimumWindowSize(app));
  await expect(pane(page)).toHaveAttribute("data-task-record", "rc-decision");
  const recordModel = taskFact(pane(page), "model");
  await expect(recordModel).toHaveText(LONG_MODEL);
  await scrollRecordBodyTo(recordModel);
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
