import { expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { BOARD_RECENT_MS } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodySelector } from "./frames";
import { launchApp } from "./launch";
import { expectClearOf, leaveWindow, type Point, resizeWindow, slidePointer } from "./layout";
import {
  activityFrame,
  atRest,
  expandDock,
  expectRecordBody,
  hideRecord,
  keySummary,
  linkedTaskKeys,
  nowRow,
  openGroup,
  POINT_SUMMARY,
  recordAttention,
  recordCard,
  recordFact,
  recordFrame,
  reportLine,
  restOnFramedKey,
  restOnRow,
  restOnTaskKey,
  rowSummary,
  shownTaskFacts,
  showRecordTab,
  taskFact,
  taskKeyLinks,
} from "./rails";
import { cardSurface, clickInBody, showCard, shownCard, shownEntry } from "./stack";
import { seedUsageLedger, usageTab } from "./usage";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * A task key a card body names is a link to that task (FI3-594): resting on
 * it opens the same summary a Tasks row opens, beside the card, and a click
 * opens the task’s record. Only a key that is
 * exactly a recorded task's links; key-shaped words that name no task -
 * the captain's own example spelling among them - stay text. The card's own
 * task's key links like any other, so a card never shows some keys as links
 * and others as text (the captain: "we should make it a link consistently").
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
        // The card's own task's key, which links like any other.
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
      ids: {
        [ledger.key]: ledger.id,
        [format.key]: format.id,
        [earlier.key]: earlier.id,
        [author.key]: author.id,
      },
    };
  } finally {
    db.close();
  }
}

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
      // The card's own task's key among them.
      await expect(linkedTaskKeys(body)).toHaveText([
        seeded.ledger,
        seeded.format,
        seeded.earlier,
        seeded.author,
        seeded.format,
      ]);
      await expect(linkedTaskKeys(body.locator("summary"))).toHaveCount(0);
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

    await test.step("a click opens the task's record", async () => {
      await clickInBody(keyLink(seeded.ledger));
      await expect(recordCard(page)).toHaveAttribute(
        "data-task-record",
        seeded.ids[seeded.ledger] ?? "",
      );
      await expectRecordBody(page);
      await expect(keySummary(page)).toHaveCount(0);
      await page.mouse.move(4, 400);
      await hideRecord(page).click();
      await expect(recordCard(page)).toHaveCount(0);
    });

    await test.step("a key opens the record even when its task has a waiting decision", async () => {
      await showCard(page, SUMMARY_CARD);
      // The record leaving the stage may cover the card for a moment.
      await expect.poll(() => onTop(page, keyLink(seeded.format))).toBe(true);
      await clickInBody(keyLink(seeded.format));
      await expect(recordCard(page)).toHaveAttribute(
        "data-task-record",
        seeded.ids[seeded.format] ?? "",
      );
      await expectRecordBody(page);
      await hideRecord(page).click();
      await expect(shownCard(page, SUMMARY_CARD)).toBeVisible();
    });

    await test.step("the card's own task's key opens that task's record in front of the card, and Hide returns to the card", async () => {
      await expect.poll(() => onTop(page, keyLink(seeded.author))).toBe(true);
      await clickInBody(keyLink(seeded.author));
      await expect(recordCard(page)).toHaveAttribute(
        "data-task-record",
        seeded.ids[seeded.author] ?? "",
      );
      await expectRecordBody(page);
      await hideRecord(page).click();
      await expect(recordCard(page)).toHaveCount(0);
      await expect(shownCard(page, SUMMARY_CARD)).toBeVisible();
    });
  } finally {
    await launched.close();
  }
});

/**
 * INF-237 ("hover a task anywhere, highlight it everywhere"): a rest on a
 * key in a card body lights its Tasks row and every other key of that task,
 * and a rest on a Tasks row lights every key of its task - in the card
 * body's frame and the key the card's own head draws.
 */
test("a task key and its Tasks row light each other, and every other key of that task", async () => {
  const userDataDir = scratchDir("infinitary-card-task-keys-lit-");
  const seeded = seed(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, SUMMARY_CARD);
    const body = cardBody(page, SUMMARY_CARD);
    const keyLinks = (key: string) => linkedTaskKeys(body).filter({ hasText: key });
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    await expect(nowRow(page, seeded.format)).toBeVisible();

    await test.step("a rest on a key lights its row and each key of that task, and no other", async () => {
      await expect(keyLinks(seeded.format)).toHaveCount(2);
      await restOnFramedKey(page, keyLinks(seeded.format).first());
      await expect(nowRow(page, seeded.format)).toHaveAttribute("data-now-lit", "");
      await expect(keyLinks(seeded.format).nth(1)).toHaveAttribute("data-inf-lit", "");
      await expect(keyLinks(seeded.ledger).first()).not.toHaveAttribute("data-inf-lit", "");
      await expect(nowRow(page, seeded.ledger)).not.toHaveAttribute("data-now-lit", "");
      await page.screenshot({ path: test.info().outputPath("lit-key-to-row.png") });
      await body.getByText("name no task").dispatchEvent("pointerover");
      await expect(nowRow(page, seeded.format)).not.toHaveAttribute("data-now-lit", "");
      await expect(linkedTaskKeys(body).and(page.locator("[data-inf-lit]"))).toHaveCount(0);
    });

    await test.step("a rest on a row lights each key of its task in the body, the last rest winning", async () => {
      await restOnRow(page, seeded.ledger);
      await expect(keyLinks(seeded.ledger).first()).toHaveAttribute("data-inf-lit", "");
      await expect(keyLinks(seeded.format).first()).not.toHaveAttribute("data-inf-lit", "");
      await restOnRow(page, seeded.format);
      await expect(keyLinks(seeded.format).first()).toHaveAttribute("data-inf-lit", "");
      await expect(keyLinks(seeded.ledger).first()).not.toHaveAttribute("data-inf-lit", "");
      await page.mouse.move(4, 400);
      await expect(keyLinks(seeded.format).first()).not.toHaveAttribute("data-inf-lit", "");
    });

    await test.step("the card's own task's keys, in its head and its body, light too, and light the row", async () => {
      // The summary card's own task is its author's.
      const head = taskKeyLinks(shownCard(page, SUMMARY_CARD)).filter({ hasText: seeded.author });
      await expect(head).toHaveCount(1);
      await restOnRow(page, seeded.author);
      await expect(nowRow(page, seeded.author)).toHaveAttribute("data-now-lit", "");
      await expect(head).toHaveAttribute("data-task-lit", "");
      await expect(keyLinks(seeded.author)).toHaveAttribute("data-inf-lit", "");
      await page.mouse.move(4, 400);
      await expect(head).not.toHaveAttribute("data-task-lit", "");
      await restOnTaskKey(page, head);
      await expect(nowRow(page, seeded.author)).toHaveAttribute("data-now-lit", "");
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

/** The audit task's card's title, which names the task it waits on and the card's own task. */
const namedCardTitle = (format: string, audit: string) =>
  `${format} holds up the walrus ledger for ${audit}`;

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
    tasks.graph.link(format.id, ledger.id, "blocks", "host");
    tasks.graph.link(ledger.id, summary.id, "blocks", "host");
    tasks.turns.recordReport(ledger.id, { text: `Half done; continues as ${summary.key}.` });
    tasks.turns.recordReport(audit.id, { text: `${ledger.key} waits on ${format.key}.` });
    const cards = new CardStore(db);
    cards.upsert({
      id: "card-named-audit",
      taskId: audit.id,
      author: "crewmate",
      priority: 30,
      title: namedCardTitle(format.key, audit.key),
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
      // The attention sentence is the window's, at the top of Info (INF-2261).
      const waitingOn = taskKeyLinks(recordAttention(page)).first();
      await restOnTaskKey(page, waitingOn);
      await expect(keySummary(page)).toHaveAttribute("data-key-summary", work.format.id);
      // Off it with the same pointer, as a pointer on its way out goes.
      const off = { x: 4, y: 400 };
      await slidePointer(page, off, off, 1);
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
      // The relations are the Info tab's rows of keys, above the goal (INF-2261).
      await expect(recordFact(page, "blocks")).toBeVisible();
      await expect(taskKeyLinks(recordAttention(page))).toHaveText([work.format.key]);
      // Part of names the parent's key, never its id.
      await expect(taskKeyLinks(recordFact(page, "parent"))).toHaveText([work.parent.key]);
      await expect(taskKeyLinks(recordFact(page, "blocked-by"))).toHaveText([work.format.key]);
      await expect(taskKeyLinks(recordFact(page, "blocks"))).toHaveText([work.summary.key]);
      await expect(taskKeyLinks(recordCard(page)).filter({ hasText: work.ledger.key })).toHaveCount(
        0,
      );
      await recordCard(page).screenshot({ path: test.info().outputPath("record-key-links.png") });
      await showRecordTab(page, "activity");
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
      await showRecordTab(page, "info");
    });

    await test.step("Enter on the key it holds up opens that task's record", async () => {
      // By keys, as the record's rows are read: the key is a Tab stop.
      await pressKey(taskKeyLinks(recordFact(page, "blocks")), "Enter");
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
    await showCard(page, namedCardTitle(work.format.key, work.audit.key));
    const cue = shownEntry(page).locator("[data-thread-cue]");
    if ((await cue.count()) > 0) await cue.click();
    const thread = shownEntry(page).locator("[data-thread-messages]");
    await expect(thread.locator('[data-thread-message="crewmate"]')).toBeVisible();

    await test.step("every author's line and the title link every key they write, the card's own task's included", async () => {
      await expect(taskKeyLinks(thread.locator('[data-thread-message="captain"]'))).toHaveText([
        work.ledger.key,
        work.format.key,
      ]);
      await expect(taskKeyLinks(thread.locator('[data-thread-message="crewmate"]'))).toHaveText([
        work.format.key,
        work.audit.key,
      ]);
      await expect(taskKeyLinks(shownEntry(page).locator("[data-card-title]"))).toHaveText([
        work.format.key,
        work.audit.key,
      ]);
    });

    await test.step("resting on a line's key opens its summary beside the card, and a click opens the task", async () => {
      const key = taskKeyLinks(thread.locator('[data-thread-message="captain"]')).first();
      await restOnTaskKey(page, key);
      await expect(keySummary(page)).toHaveAttribute("data-key-summary", work.ledger.id);
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

test("the key in a card's head opens its task's record, and Hide returns to the card", async () => {
  // INF-358: the captain's "on all the decision cards we should figure out
  // how we give the user a way to go to the task from there", built as the
  // task's key leading the head, and "let's make sure the task key is added
  // to all decision cards about a task".
  const userDataDir = scratchDir("infinitary-card-head-key-");
  const work = seedNamedWork(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1440, height: 900 });
    const title = namedCardTitle(work.format.key, work.audit.key);
    await showCard(page, title);
    const head = shownCard(page, title).locator("[data-card-head]");
    const headKey = taskKeyLinks(head.locator("[data-card-key]"));

    await test.step("the head leads with the card's own task's key, before the meta line and the model chip", async () => {
      await expect(headKey).toHaveText([work.audit.key]);
      await expect(head.locator("[data-card-meta]")).toHaveText("crewmate 1");
      await expect(taskKeyLinks(shownEntry(page).locator("[data-card-title]"))).toHaveText([
        work.format.key,
        work.audit.key,
      ]);
      await cardSurface(page).screenshot({ path: test.info().outputPath("card-head-key.png") });
    });

    await test.step("resting on it opens the task's summary beside the card", async () => {
      await restOnTaskKey(page, headKey);
      await expect(keySummary(page)).toHaveAttribute("data-key-summary", work.audit.id);
      const off = { x: 4, y: 400 };
      await slidePointer(page, off, off, 1);
      await expect(keySummary(page)).toHaveCount(0);
    });

    await test.step("Enter on it opens the record in front of the card, and Hide comes back to the card", async () => {
      await pressKey(headKey, "Enter");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", work.audit.id);
      await expectRecordBody(page);
      await expect(keySummary(page)).toHaveCount(0);
      await hideRecord(page).click();
      await expect(recordCard(page)).toHaveCount(0);
      await expect(shownCard(page, title)).toBeVisible();
    });

    await test.step("Show Info from command search opens the same record, and Esc comes back too", async () => {
      await runFromSearch(app, page, "cards.show-info");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", work.audit.id);
      await page.keyboard.press("Escape");
      await expect(recordCard(page)).toHaveCount(0);
      await expect(shownCard(page, title)).toBeVisible();
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
      // The rest is the lit task (INF-237): the panel draws it from the view the window hands it.
      await expect(taskKeyLinks(line).nth(1)).toHaveAttribute("data-task-lit", "");
      await expect(taskKeyLinks(line).nth(2)).not.toHaveAttribute("data-task-lit", "");
      await page.mouse.move(700, 400);
      await expect(rowSummary(page)).toHaveCount(0);
      await expect(taskKeyLinks(line).nth(1)).not.toHaveAttribute("data-task-lit", "");
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

/**
 * INF-702, the captain's words: "every time i slide my mouse across the left
 * edge and leave the infinitary window, it always seems to trigger a random
 * task's hover preview to show up". Activity is on the left rail in a frame
 * of its own, and the exit macOS hands the window never reaches that frame,
 * so the key the pointer left from must not keep its summary open.
 */
test("leaving the window across its left edge from a task key in Activity closes its summary", async () => {
  const userDataDir = scratchDir("infinitary-activity-key-leave-");
  const work = seedNamedWork(userDataDir);
  const launched = await launchApp({ userDataDir, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1440, height: 900 });
    await expandDock(page, "activity");
    const key = taskKeyLinks(reportLine(page, work.audit.key)).nth(1);
    await expect(key).toHaveText(work.ledger.key);
    await restOnTaskKey(page, key);
    await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, work.ledger.id);
    const box = await key.boundingBox();
    if (!box) throw new Error("The task key is not on screen");
    await leaveWindow(app, page, { x: -1, y: Math.round(box.y + box.height / 2) });
    await expect(rowSummary(page)).toHaveCount(0);
    await expect(key).not.toHaveAttribute("data-task-lit", "");
    await page.screenshot({ path: test.info().outputPath("leave/left-edge.png") });
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

const CHOICE_CARD = "Pick the ledger work to start";

/**
 * INF-3945 (the captain: "why the task key is not turned into a link? hard to
 * know what it even is without it being a link"): a key in a choice's label
 * links like a key in the body's words. A click or Enter on the key opens its
 * task and leaves the checkbox or radio as it was; the label's other words
 * still pick the choice.
 */
function seedChoices(userDataDir: string): {
  ids: { ledger: string; format: string };
  keys: [string, string];
} {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    const ledger = seedTask(tasks, {
      id: "choice-ledger",
      title: LEDGER_TITLE,
      status: "queued",
      startPolicy: "on-request",
    });
    const format = seedTask(tasks, {
      id: "choice-format",
      title: "Choose the ledger format",
      status: "queued",
      startPolicy: "on-request",
    });
    const author = seedTask(tasks, {
      id: "choice-author",
      title: "Plan the ledger work",
      status: "queued",
      startPolicy: "on-request",
    });
    new CardStore(db).upsert({
      id: "card-choice-author-1",
      taskId: author.id,
      author: "crewmate",
      priority: 20,
      title: CHOICE_CARD,
      meta: "crewmate 1",
      body:
        "<p>Two pieces of ledger work are ready.</p>" +
        `<fieldset><legend>Ledger work</legend><label><input type="checkbox" name="start" value="ledger"> Start <span class="inf-mono">${ledger.key}</span> now, before the format is chosen</label></fieldset>` +
        `<fieldset data-inf-options-only><legend>Format</legend><label><input type="radio" name="format" value="choose"> Let ${format.key} choose the format</label>` +
        '<label><input type="radio" name="format" value="csv"> Use CSV</label></fieldset>',
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "later", label: "Not now", variant: "secondary" },
        { id: "go", label: "Start", variant: "primary", default: true },
      ],
    });
    return { ids: { ledger: ledger.id, format: format.id }, keys: [ledger.key, format.key] };
  } finally {
    db.close();
  }
}

test("a task key in a choice's label opens its task and leaves the choice as it was", async () => {
  const userDataDir = scratchDir("infinitary-choice-task-keys-");
  const { ids, keys } = seedChoices(userDataDir);
  const [ledgerKey, formatKey] = keys;
  const launched = await launchApp({ userDataDir });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, CHOICE_CARD);
    const body = cardBody(page, CHOICE_CARD);
    const checkbox = body.locator('input[name="start"]');
    const radio = body.locator('input[name="format"][value="choose"]');

    await test.step("each key a label writes is a link, inside its label", async () => {
      await expect(linkedTaskKeys(body)).toHaveText([ledgerKey, formatKey]);
      await expect(linkedTaskKeys(body.locator("label"))).toHaveText([ledgerKey, formatKey]);
      await cardSurface(page).screenshot({ path: test.info().outputPath("choice-key-links.png") });
    });

    await test.step("a click on the key opens its task and leaves the checkbox unpicked", async () => {
      await clickInBody(linkedTaskKeys(body).filter({ hasText: ledgerKey }));
      await expect(recordCard(page)).toHaveAttribute("data-task-record", ids.ledger);
      await page.mouse.move(4, 400);
      await hideRecord(page).click();
      await expect(shownCard(page, CHOICE_CARD)).toBeVisible();
      await expect(checkbox).not.toBeChecked();
    });

    await test.step("Enter on a radio's key opens its task and leaves the radio unpicked", async () => {
      await pressKey(linkedTaskKeys(body).filter({ hasText: formatKey }), "Enter");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", ids.format);
      await hideRecord(page).click();
      await expect(shownCard(page, CHOICE_CARD)).toBeVisible();
      await expect(radio).not.toBeChecked();
    });

    await test.step("a click on the label's other words still picks the choice", async () => {
      await clickInBody(body.locator("label").filter({ has: checkbox }));
      await expect(checkbox).toBeChecked();
      await expect(recordCard(page)).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});
