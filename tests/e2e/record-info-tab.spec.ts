import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import {
  expandDock,
  nowFrame,
  openRecordMore,
  pressRow,
  RECORD_FRAME_SELECTOR,
  recordCard,
  recordFrame,
  recordTab,
} from "./rails";
import { pager } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

const GOAL = "Chart the harbour's soundings.";

/**
 * INF-2261, the captain's approved Info tab: "tab_order: Info, Cards,
 * Activity, Crewmate, then Browser. tab_counts: Cards shows how many,
 * Activity none", the captain's words "Folded under the goal, closed", the
 * row of facts in the body, and "One closed More row at the end of Info,
 * remembered per task". A closed task a crewmate ran, with the captain's
 * words and two cards, has Info, Cards, Activity and Crewmate.
 */
test("a task card's tabs run Info, Cards, Activity, Crewmate, and Info ends in a More row that stays open per task", async () => {
  const userDataDir = scratchDir("infinitary-record-info-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "info-task",
    title: "Chart the harbour",
    intent: { goal: GOAL, userWords: "Chart the harbour for me." },
    status: "completed",
    branch: "chart-harbour",
  });
  // A second finished task to page to, so the first record is left and come back to.
  const other = seedTask(tasks, {
    id: "info-other",
    title: "Survey the reef",
    intent: { goal: "Survey the reef.", userWords: "Survey the reef." },
    status: "completed",
  });
  tasks.close(other.id, { status: "done", reason: "answered", actor: "captain", text: "answered" });
  const store = new CardStore(db);
  const at = Date.now() - 3_600_000;
  for (const [index, title] of ["Soundings are in", "Chart is ready"].entries()) {
    store.upsert({
      id: `info-card-${index}`,
      taskId: task.id,
      title,
      author: "firstmate",
      priority: 50,
      meta: "harbour",
      body: `<p>${title}.</p>`,
      status: "ready",
      createdAt: at + index * 1_000,
      actions: [],
    });
    store.resolve(`info-card-${index}`, "close");
  }
  tasks.close(task.id, { status: "done", reason: "answered", actor: "captain", text: "answered" });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="landed"]')
      .evaluate((el) => (el as HTMLElement).click());
    await pressRow(page, task.key);
    const pane = recordCard(page);
    await expect(pane).toHaveAttribute("data-task-record", task.id);

    const tabs = pane.locator("[data-task-tab]");
    await expect(tabs).toHaveCount(4);
    expect(
      await tabs.evaluateAll((all) => all.map((tab) => tab.getAttribute("data-task-tab"))),
    ).toEqual(["info", "cards", "activity", "crewmate"]);
    await expect(recordTab(page, "info")).toHaveAttribute("aria-selected", "true");
    await expect(recordTab(page, "cards").locator("[data-task-tab-count]")).toHaveText("2");
    await expect(recordTab(page, "activity").locator("[data-task-tab-count]")).toHaveCount(0);
    await expect(recordTab(page, "crewmate").locator("[data-task-tab-count]")).toHaveCount(0);

    // Info: the goal, the captain's words folded closed under it, the row of
    // facts, then More last, closed until opened.
    await expect(pane.locator("[data-record-goal]")).toHaveText(GOAL);
    const fold = pane.locator('[data-record-section="words"]');
    await expect(fold).not.toHaveAttribute("open", /.*/);
    await expect(pane.locator("[data-record-words]")).toBeHidden();
    const order = await pane.evaluate((card, frame) => {
      const at = (selector: string) => card.querySelector(selector);
      const follows = (a: Element | null, b: Element | null) =>
        Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const goal = at("[data-record-goal]");
      const words = at('[data-record-section="words"]');
      const strip = at("[data-record-strip]");
      const body = at(frame);
      return {
        wordsAfterGoal: follows(goal, words),
        stripAfterWords: follows(words, strip),
        moreAfterStrip: follows(strip, body),
      };
    }, RECORD_FRAME_SELECTOR);
    expect(order).toEqual({ wordsAfterGoal: true, stripAfterWords: true, moreAfterStrip: true });
    const more = recordFrame(page).locator('[data-record-section="details"]');
    await expect(more).toBeVisible();
    await expect(more).not.toHaveAttribute("open", /.*/);

    await focusOn(recordTab(page, "info"));
    await pressKey(recordTab(page, "info"), "ArrowRight");
    await pressKey(recordTab(page, "cards"), "Enter");
    await expect(recordTab(page, "cards")).toHaveAttribute("aria-selected", "true");
    await expect(recordFrame(page).locator("[data-record][data-view='cards']")).toBeAttached();
    await expect(recordFrame(page).locator("[data-record-card]")).toHaveCount(2);
    await expect(pane.locator("[data-record-goal]")).toHaveCount(0);
    await pressKey(recordTab(page, "cards"), "ArrowLeft");
    await pressKey(recordTab(page, "info"), "Enter");
    await expect(recordTab(page, "info")).toHaveAttribute("aria-selected", "true");

    // More opens and stays open for this task when another task's card is
    // shown and this one is come back to. Pressing its row again returns to
    // the same entry, never a second one (two entries stay). (Closing a
    // record ends its visit: reopening starts compact, docs/task-record.md.)
    await openRecordMore(page);
    await pressRow(page, other.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", other.id);
    await expect(pager(page, 2)).toBeVisible();
    await pressRow(page, task.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
    await expect(pager(page, 2)).toBeVisible();
    await expect(recordFrame(page).locator('[data-record-section="details"]')).toHaveAttribute(
      "open",
      "",
    );
    await page.screenshot({ path: test.info().outputPath("record-info-tab.png") });
  } finally {
    await launched.close();
  }
});
