import { expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { BOARD_RECENT_MS } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodySelector } from "./frames";
import { launchApp } from "./launch";
import { expectClearOf, type Point, resizeWindow, slidePointer } from "./layout";
import {
  activityFrame,
  atRest,
  expandDock,
  hideRecord,
  keySummary,
  linkedTaskKeys,
  nowRow,
  openGroup,
  POINT_SUMMARY,
  recordCard,
  recordFact,
  recordFrame,
  reportLine,
  restOnFramedKey,
  restOnRow,
  restOnTaskKey,
  rowSummary,
  shownTaskFacts,
  taskFact,
  taskKeyLinks,
} from "./rails";
import { cardSurface, clickInBody, showCard, shownCard, shownEntry } from "./stack";
import { seedUsageLedger, usageTab } from "./usage";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * A task key a card body names is a link to that task (FI3-594): resting on
 * it opens the same summary a Tasks row opens, beside the card, and a click
 * opens the task the way a click on its Tasks row does. Only a key that is
 * exactly a recorded task's links; key-shaped words that name no task -
 * the captain's own example spelling among them - stay text.
 */

const DAY = 24 * 60 * 60 * 1000;
const SUMMARY_CARD = "The ledger summary is ready";
const DECISION_CARD = "Pick the ledger format";
const LEDGER_TITLE = "Reconcile the walrus ledger";
const EARLIER_TITLE = "Archive the walrus notes";

type Seeded = {
  ledger: string;
  format: string;
  earlier: string;
  author: string;
  ids: Record<string, string>;
};

/**
 * A planned task, a planned task waiting on a decision, work closed long
 * enough ago that the board no longer lists it, and a note naming all
 * three beside words shaped like keys that name nothing, and a link the
 * author wrote. Nothing is started, so no crewmate wakes during the test.
 */
function seed(userDataDir: string): Seeded {
  const db = openDatabase(userDataDir);
  try {
    const old = new TaskService({ db, strict: true, now: () => Date.now() - 8 * DAY });
    old.create({
      id: "keys-earlier",
      title: EARLIER_TITLE,
      prompt: "p",
      repoId: null,
    });
    old.close("keys-earlier", { status: "done", reason: "settled", actor: "host" });
    const tasks = new TaskService({ db, strict: true });
    const earlier = tasks.get("keys-earlier");
    if (!earlier) throw new Error("The earlier task did not seed");
    const ledger = seedTask(tasks, {
      id: "keys-ledger",
      title: LEDGER_TITLE,
      status: "queued",
      startPolicy: "on-request",
    });
    const format = seedTask(tasks, {
      id: "keys-format",
      title: "Choose the ledger format",
      status: "queued",
      startPolicy: "on-request",
    });
    const author = seedTask(tasks, {
      id: "keys-author",
      title: "Summarize the ledger work",
      status: "queued",
      startPolicy: "on-request",
    });
    const cards = new CardStore(db);
    cards.upsert({
      id: "card-keys-format-1",
      taskId: format.id,
      author: "crewmate",
      priority: 20,
      title: DECISION_CARD,
      meta: "crewmate 2",
      body: "<p>The ledger can be written as CSV or JSON.</p>",
      status: "ready",
      createdAt: Date.now() - 60_000,
      actions: [
        { id: "json", label: "Use JSON", variant: "secondary" },
        { id: "csv", label: "Use CSV", variant: "primary", default: true },
      ],
    });
    cards.upsert({
      id: "card-keys-author-1",
      taskId: author.id,
      author: "crewmate",
      priority: 30,
      title: SUMMARY_CARD,
      meta: "crewmate 1",
      body:
        `<p>I read the reconciliation in ${ledger.key} before writing this summary.</p>` +
        `<p>${format.key} still waits on your choice of format.</p>` +
        `<p>The older notes are in <span class="inf-mono">${earlier.key}</span>.</p>` +
        "<p>F13-572 and ZZ9-404 name no task, so they stay plain text.</p>" +
        `<p>The author's own link stays one: <a href="https://example.com/">${ledger.key}</a>.</p>` +
        // The card's own task: opening it would only bring this card forward.
        `<p>Written for ${author.key}.</p>` +
        // A toggle is a control of its own; what it opens to is words.
        `<details><summary>About ${ledger.key}</summary><p>It waits on ${format.key}.</p></details>`,
      status: "ready",
      createdAt: Date.now(),
      actions: [],
    });
    return {
      ledger: ledger.key,
      format: format.key,
      earlier: earlier.key,
      author: author.key,
      ids: { [ledger.key]: ledger.id, [format.key]: format.id, [earlier.key]: earlier.id },
    };
  } finally {
    db.close();
  }
}

/** Whether the summary card's body is what the window shows at `target`'s centre. */
async function onTop(page: Page, target: Locator): Promise<boolean> {
  const box = await target.boundingBox();
  if (!box) return false;
  return page.evaluate(
    ([x, y, selector]) => document.elementFromPoint(x, y) === document.querySelector(selector),
    [box.x + box.width / 2, box.y + box.height / 2, cardBodySelector(SUMMARY_CARD)] as const,
  );
}

test("a task key in a card body opens its task's summary on a rest and the task on a click", async () => {
  expect(BOARD_RECENT_MS).toBeLessThan(8 * DAY);
  const userDataDir = scratchDir("infinitary-card-task-keys-");
  const seeded = seed(userDataDir);
  const launched = await launchApp({ userDataDir });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    const body = cardBody(page, SUMMARY_CARD);
    const keyLink = (key: string) => linkedTaskKeys(body).filter({ hasText: key }).first();
    // Keep entry and exit in the same frame event stream. A dispatched exit
    // does not move Chromium's native pointer: its next hover can send only
    // pointermove, never the pointerover that starts the summary. The separate
    // sliding journey below covers real pointer entry across the frame boundary.
    const restOnKey = async (key: string) => {
      const link = keyLink(key);
      await atRest(page, link);
      await link.dispatchEvent("pointerover");
    };

    await test.step("only keys that name recorded tasks become links, wherever the body writes them", async () => {
      await showCard(page, SUMMARY_CARD);
      await expect(linkedTaskKeys(body)).toHaveText([
        seeded.ledger,
        seeded.format,
        seeded.earlier,
        seeded.format,
      ]);
      // The card's own task's key, and a key in a toggle's summary, stay as written.
      await expect(body.getByText(`Written for ${seeded.author}.`)).toBeVisible();
      await expect(linkedTaskKeys(body).filter({ hasText: seeded.author })).toHaveCount(0);
      await expect(linkedTaskKeys(body.locator("summary"))).toHaveCount(0);
      // A key-shaped word that names no task, and the author's own link, stay as written.
      await expect(body.getByText("F13-572 and ZZ9-404 name no task")).toBeVisible();
      await expect(body.locator("a", { hasText: "F13-572" })).toHaveCount(0);
      await expect(body.locator("a", { hasText: "ZZ9-404" })).toHaveCount(0);
      await expect(body.locator('a[href="https://example.com/"]')).toHaveText(seeded.ledger);
      await expect(body.locator('a[href="https://example.com/"] [data-inf-task]')).toHaveCount(0);
      await expect(keyLink(seeded.ledger)).toHaveAttribute("role", "link");
      await cardSurface(page).screenshot({ path: test.info().outputPath("card-key-links.png") });
    });

    let fromRow: [string, string][] = [];
    await test.step("its Tasks row's summary, read for comparison", async () => {
      await expandDock(page, "now");
      await openGroup(page, "backlog");
      await restOnRow(page, seeded.ledger);
      const summary = rowSummary(page).locator("[data-crew-summary]");
      await expect(summary).toHaveAttribute("data-crew-summary", seeded.ids[seeded.ledger] ?? "");
      await expect
        .poll(async () => (await shownTaskFacts(summary)).map(([id]) => id))
        .toContain("project");
      fromRow = await shownTaskFacts(summary);
      await page.mouse.move(4, 400);
      await expect(rowSummary(page)).toHaveCount(0);
    });

    await test.step("resting on a key opens that same summary, clear of the key", async () => {
      await restOnKey(seeded.ledger);
      await expect(keySummary(page)).toHaveAttribute(
        "data-key-summary",
        seeded.ids[seeded.ledger] ?? "",
      );
      const summary = keySummary(page).locator("[data-crew-summary]");
      await expect(summary.locator("[data-crew-summary-key]")).toHaveText(seeded.ledger);
      await expect(taskFact(summary, "task")).toHaveText(LEDGER_TITLE);
      // The same facts, words and order as its Tasks row.
      await expect.poll(() => shownTaskFacts(summary)).toEqual(fromRow);
      await expectClearOf(
        page,
        summary,
        linkedTaskKeys(body).filter({ hasText: seeded.ledger }).first(),
        page.locator("[data-prompt-dock]"),
      );
      await page.screenshot({ path: test.info().outputPath("key-summary-under.png") });
    });

    await test.step("the summary remains reachable in a wider window", async () => {
      // Off the key inside the card, as a pointer on its way out goes.
      await body.getByText("name no task").dispatchEvent("pointerover");
      await expect(keySummary(page)).toHaveCount(0);
      await resizeWindow(app, page, { width: 1640, height: 900 });
      await restOnKey(seeded.ledger);
      await expect(keySummary(page)).toHaveCount(1);
      await expectClearOf(
        page,
        keySummary(page).locator("[data-crew-summary]"),
        linkedTaskKeys(body).filter({ hasText: seeded.ledger }).first(),
        page.locator("[data-prompt-dock]"),
      );
      await page.screenshot({ path: test.info().outputPath("key-summary-beside.png") });
    });

    await test.step("a key for work the board no longer lists opens its summary too", async () => {
      await restOnKey(seeded.earlier);
      await expect(keySummary(page)).toHaveAttribute(
        "data-key-summary",
        seeded.ids[seeded.earlier] ?? "",
      );
      await expect(taskFact(keySummary(page).locator("[data-crew-summary]"), "task")).toHaveText(
        EARLIER_TITLE,
      );
    });

    await test.step("leaving the key closes it, and so does Esc until the pointer leaves the key", async () => {
      await body.getByText("name no task").dispatchEvent("pointerover");
      await expect(keySummary(page)).toHaveCount(0);
      await restOnKey(seeded.ledger);
      await expect(keySummary(page)).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(keySummary(page)).toHaveCount(0);
      await expect(shownCard(page, SUMMARY_CARD)).toBeVisible();
    });

    await test.step("a click opens the task's record, as a click on its Tasks row does", async () => {
      await clickInBody(keyLink(seeded.ledger));
      await expect(recordCard(page)).toHaveAttribute(
        "data-task-record",
        seeded.ids[seeded.ledger] ?? "",
      );
      await expect(keySummary(page)).toHaveCount(0);
      await page.mouse.move(4, 400);
      await hideRecord(page).click();
      await expect(recordCard(page)).toHaveCount(0);
    });

    await test.step("a click on a task waiting on a decision brings that decision forward", async () => {
      await showCard(page, SUMMARY_CARD);
      // The record leaving the stage may cover the card for a moment.
      await expect.poll(() => onTop(page, keyLink(seeded.format))).toBe(true);
      await clickInBody(keyLink(seeded.format));
      await expect(shownCard(page, DECISION_CARD)).toBeVisible();
      await expect(recordCard(page)).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});

test("sliding into a task key from beside the card opens its summary", async () => {
  const userDataDir = scratchDir("infinitary-card-task-keys-slide-");
  const seeded = seed(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1640, height: 900 });
    await showCard(page, SUMMARY_CARD);
    const body = cardBody(page, SUMMARY_CARD);
    const link = linkedTaskKeys(body).filter({ hasText: seeded.ledger }).first();
    await expect(link).toBeVisible();
    // Only the synthetic mouse from here on: it crosses into the card's frame
    // the way a real mouse does, window move and all.
    await atRest(page, link);
    const [key, card] = await Promise.all([link.boundingBox(), cardSurface(page).boundingBox()]);
    if (!key || !card) throw new Error("The key is not on screen");
    const middle = { x: key.x + key.width / 2, y: key.y + key.height / 2 };
    const starts: [string, Point][] = [
      ["left", { x: card.x - 120, y: middle.y }],
      ["right", { x: card.x + card.width + 120, y: middle.y }],
    ];
    for (const [side, start] of starts) {
      await test.step(`from the ${side} of the card`, async () => {
        await slidePointer(page, start, start, 1);
        await expect(keySummary(page)).toHaveCount(0);
        await slidePointer(page, start, middle, 16);
        await expect(keySummary(page)).toHaveAttribute(
          "data-key-summary",
          seeded.ids[seeded.ledger] ?? "",
        );
      });
    }
  } finally {
    await launched.close();
  }
});

/**
 * Work that names other work everywhere the app draws it (FI3-1271): a
 * task waiting on another, part of a third and holding up a fourth, whose
 * report names the work it continues as, and a card of the audit task's
 * with a thread naming the others. Nothing is started.
 */
function seedNamedWork(userDataDir: string) {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    const unstarted = { status: "queued", startPolicy: "on-request" } as const;
    const parent = seedTask(tasks, {
      id: "named-parent",
      title: "Plan the walrus migration",
      ...unstarted,
    });
    const format = seedTask(tasks, {
      id: "named-format",
      title: "Choose the ledger format",
      ...unstarted,
    });
    const ledger = seedTask(tasks, {
      id: "named-ledger",
      title: "Reconcile the walrus ledger",
      parentId: parent.id,
      ...unstarted,
    });
    const summary = seedTask(tasks, {
      id: "named-summary",
      title: "Summarize the ledger work",
      ...unstarted,
    });
    const audit = seedTask(tasks, {
      id: "named-audit",
      title: "Audit the walrus notes",
      ...unstarted,
    });
    tasks.link(format.id, ledger.id, "blocks", "host");
    tasks.link(ledger.id, summary.id, "blocks", "host");
    tasks.recordReport(ledger.id, { text: `Half done; continues as ${summary.key}.` });
    tasks.recordReport(audit.id, { text: `${ledger.key} waits on ${format.key}.` });
    const cards = new CardStore(db);
    cards.upsert({
      id: "card-named-audit",
      taskId: audit.id,
      author: "crewmate",
      priority: 30,
      title: `${format.key} holds up the walrus ledger`,
      meta: "crewmate 1",
      body: "<p>The ledger cannot start yet.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [],
    });
    cards.appendMessage({
      cardId: "card-named-audit",
      who: "captain",
      text: `Does ${ledger.key} have to wait for ${format.key}?`,
    });
    cards.appendMessage({
      cardId: "card-named-audit",
      who: "crewmate",
      text: `Yes. ${format.key} chooses the format first; ${audit.key} writes it up after.`,
    });
    return { parent, format, ledger, summary, audit };
  } finally {
    db.close();
  }
}

test("a task's record links every other task's key it shows, and its own stays text", async () => {
  const userDataDir = scratchDir("infinitary-record-task-keys-");
  const work = seedNamedWork(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1440, height: 1040 });
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    // By keys, as the journey goes on: Enter on its Tasks row opens its record.
    await pressKey(nowRow(page, work.ledger.key), "Enter");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", work.ledger.id);
    const body = recordFrame(page);

    await test.step("resting on the key it waits on opens that task's summary beside the record", async () => {
      const waitingOn = linkedTaskKeys(body.locator("[data-record-attention]")).first();
      await restOnFramedKey(page, waitingOn);
      await expect(keySummary(page)).toHaveAttribute("data-key-summary", work.format.id);
      // Off the key inside the record, as a pointer on its way out goes.
      await body.locator("[data-record-attention-guidance]").dispatchEvent("pointerover");
      await expect(keySummary(page)).toHaveCount(0);
    });

    await test.step("the Now line's key, drawn by the window, rests and opens the same way", async () => {
      const now = taskKeyLinks(taskFact(recordCard(page), "now"));
      await expect(now).toHaveText([work.summary.key]);
      await restOnTaskKey(page, now);
      await expect(keySummary(page)).toHaveAttribute("data-key-summary", work.summary.id);
      // Off it with the same pointer, which leaves the keyboard in the Tasks list.
      const off = { x: 4, y: 400 };
      await slidePointer(page, off, off, 1);
      await expect(keySummary(page)).toHaveCount(0);
    });

    await test.step("what it waits on, its parent, what it holds up and its Activity's words link; its own key never", async () => {
      await clickInBody(body.locator('[data-record-section="details"] > summary'));
      await expect(recordFact(page, "blocks")).toBeVisible();
      await expect(linkedTaskKeys(body.locator("[data-record-attention]"))).toHaveText([
        work.format.key,
      ]);
      // Part of names the parent's key, never its id.
      await expect(linkedTaskKeys(recordFact(page, "parent"))).toHaveText([work.parent.key]);
      await expect(linkedTaskKeys(recordFact(page, "blocked-by"))).toHaveText([work.format.key]);
      await expect(linkedTaskKeys(recordFact(page, "blocks"))).toHaveText([work.summary.key]);
      // Another task's line ends in that task's key, and the report's words name the work it continues as.
      await expect(
        linkedTaskKeys(
          body.locator(`[data-record-from="${work.summary.key}"] [data-record-from-key]`),
        ),
      ).toHaveText([work.summary.key]);
      await expect(
        linkedTaskKeys(body.locator('[data-record-section="timeline"]')).filter({
          hasText: work.summary.key,
        }),
      ).not.toHaveCount(0);
      await expect(linkedTaskKeys(body).filter({ hasText: work.ledger.key })).toHaveCount(0);
      await recordCard(page).screenshot({ path: test.info().outputPath("record-key-links.png") });
    });

    await test.step("Enter on the key it holds up opens that task's record", async () => {
      // By keys, as the record's Activity is read: the key is a Tab stop.
      await pressKey(linkedTaskKeys(recordFact(page, "blocks")), "Enter");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", work.summary.id);
    });
  } finally {
    await launched.close();
  }
});

test("a task key in a thread line or a card's title opens its summary on a rest and its task on a click", async () => {
  const userDataDir = scratchDir("infinitary-thread-task-keys-");
  const work = seedNamedWork(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1640, height: 900 });
    await showCard(page, `${work.format.key} holds up the walrus ledger`);
    const cue = shownEntry(page).locator("[data-thread-cue]");
    if ((await cue.count()) > 0) await cue.click();
    const thread = shownEntry(page).locator("[data-thread-messages]");
    await expect(thread.locator('[data-thread-message="crewmate"]')).toBeVisible();

    await test.step("every author's line links other work's keys; the card's own task's stays text", async () => {
      await expect(taskKeyLinks(thread.locator('[data-thread-message="captain"]'))).toHaveText([
        work.ledger.key,
        work.format.key,
      ]);
      await expect(taskKeyLinks(thread.locator('[data-thread-message="crewmate"]'))).toHaveText([
        work.format.key,
      ]);
      await expect(thread.getByText(work.audit.key)).toBeVisible();
      await expect(taskKeyLinks(shownEntry(page).locator("[data-card-title]"))).toHaveText([
        work.format.key,
      ]);
    });

    await test.step("resting on a line's key opens its summary beside the card, and a click opens the task", async () => {
      const key = taskKeyLinks(thread.locator('[data-thread-message="captain"]')).first();
      await restOnTaskKey(page, key);
      await expect(keySummary(page)).toHaveAttribute("data-key-summary", work.ledger.id);
      // Never over the key it is tied to.
      const [at, summary] = await Promise.all([
        key.boundingBox(),
        keySummary(page).locator("[data-crew-summary]").boundingBox(),
      ]);
      if (!at || !summary) throw new Error("The key or its summary is not on screen");
      const covers =
        summary.x < at.x + at.width &&
        summary.x + summary.width > at.x &&
        summary.y < at.y + at.height &&
        summary.y + summary.height > at.y;
      expect(covers).toBe(false);
      await key.click();
      await expect(recordCard(page)).toHaveAttribute("data-task-record", work.ledger.id);
      await expect(keySummary(page)).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});

test("a task key in Activity opens its summary beside the panel, by pointer and by keys", async () => {
  const userDataDir = scratchDir("infinitary-activity-task-keys-");
  const work = seedNamedWork(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1440, height: 900 });
    await expandDock(page, "activity");
    const line = reportLine(page, work.audit.key);
    // The line's own key, then the keys its words write.
    await expect(taskKeyLinks(line)).toHaveText([work.audit.key, work.ledger.key, work.format.key]);

    await test.step("resting on a key in the words opens its task's summary beside the panel", async () => {
      await restOnTaskKey(page, taskKeyLinks(line).nth(1));
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, work.ledger.id);
      await page.mouse.move(700, 400);
      await expect(rowSummary(page)).toHaveCount(0);
    });

    await test.step("each key is a Tab stop after the list, and focusing one opens its summary", async () => {
      const scroller = activityFrame(page).locator("[data-feed-scroller]");
      await pressKey(scroller, "Tab");
      const first = taskKeyLinks(activityFrame(page)).first();
      await expect(first).toBeFocused();
      const idOf = Object.fromEntries(Object.values(work).map((task) => [task.key, task.id]));
      await expect(rowSummary(page)).toHaveAttribute(
        POINT_SUMMARY,
        idOf[(await first.textContent()) ?? ""] ?? "",
      );
    });

    await test.step("a click opens the task as its Tasks row does", async () => {
      await clickInBody(taskKeyLinks(line).nth(2));
      await expect(recordCard(page)).toHaveAttribute("data-task-record", work.format.id);
    });
  } finally {
    await launched.close();
  }
});

test("a task key in Settings › Usage opens its summary there, and a click opens the task on the main view", async () => {
  const userDataDir = scratchDir("infinitary-usage-task-keys-");
  seedUsageLedger(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1440, height: 900 });
    await runFromSearch(app, page, "settings.usage");
    const tab = usageTab(page);
    const row = tab.tasks.first();
    const key = (await row.getAttribute("data-usage-task")) ?? "";
    const link = taskKeyLinks(row);
    await expect(link).toHaveText([key]);
    await restOnTaskKey(page, link);
    const summary = keySummary(page);
    await expect(summary.locator("[data-crew-summary-key]")).toHaveText(key);
    const taskId = (await summary.getAttribute("data-key-summary")) ?? "";
    await link.click();
    await expect(tab.section).toHaveCount(0);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", taskId);
  } finally {
    await launched.close();
  }
});
