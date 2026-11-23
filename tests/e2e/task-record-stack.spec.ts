import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  expandDock,
  expectRecordBody,
  hideRecord,
  nowFrame,
  pressRow,
  recordCard,
  recordFrame,
  reportLine,
  taskKey,
} from "./rails";
import { cardLeave, pagerAt, showCard, shownCard } from "./stack";

const CHART_GOAL = "Keep the harbour chart readable.";

async function click(node: ReturnType<Page["locator"]>) {
  await node.evaluate((el) => (el as HTMLElement).click());
}
async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.fill(text);
  await input.press("Enter");
}

test("records page one per task beside the cards, and the character returns when the stack is empty", async () => {
  const userDataDir = scratchDir("infinitary-record-stack-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const chart = seedTask(tasks, {
    id: "stack-chart",
    title: "Chart the harbour",
    status: "queued",
    startPolicy: "on-request",
    intent: {
      goal: CHART_GOAL,
      userWords: Array.from(
        { length: 70 },
        (_, i) =>
          `${i + 1}. Read all the harbour soundings in this task record, without a nested scroll surface.`,
      ).join("\n\n"),
    },
  });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await send(page, `${SPAWN_PROMPT_MARKER} Read the tide tables`);
    const crewKey = await taskKey(page, "Read the tide tables");
    await expect(reportLine(page, crewKey)).toBeVisible({ timeout: 30_000 });
    const character = page.locator("[data-character-frame]");
    await expect(character).toBeVisible();
    await expandDock(page, "now");
    await click(nowFrame(page).locator('[data-now-group-header="backlog"]'));
    await pressRow(page, chart.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", chart.id);
    await expect(recordCard(page).locator("[data-record-goal]")).toHaveText(CHART_GOAL);
    await expect(character).toBeHidden();
    await expect(character).toHaveAttribute("inert", "");
    await page.screenshot({ path: test.info().outputPath("dark-record.png") });

    await pressRow(page, crewKey);
    await expect(pagerAt(page, 1, 2)).toBeVisible();
    await pressRow(page, chart.key);
    await expect(pagerAt(page, 1, 2)).toBeVisible();
    await expect(nowFrame(page).locator("[data-now-selected]")).toHaveCount(2);
    await page.getByRole("button", { name: "Next card" }).click();
    await expect(recordCard(page)).not.toHaveAttribute("data-task-record", chart.id);
    await page.getByRole("button", { name: "Previous card" }).click();
    await expect(recordCard(page)).toHaveAttribute("data-task-record", chart.id);
    await page.mouse.click(20, 100);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", chart.id);

    await send(page, ANSWER_PROMPT_MARKER);
    await expect(pagerAt(page, 1, 3)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-unread-dot="after"]')).toBeVisible();
    await expect(recordCard(page)).toHaveAttribute("data-task-record", chart.id);
    await expect(character).toBeHidden();
    await page.screenshot({ path: test.info().outputPath("arrival-behind-record.png") });
    await showCard(page, MOCK_ANSWER_TITLE);
    await page.keyboard.press("Escape");
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible();
    await expect(nowFrame(page).locator("[data-now-selected]")).toHaveCount(2);
    await page.getByRole("button", { name: "Previous card" }).click();
    await page.getByRole("button", { name: "Previous card" }).click();
    await expect(recordCard(page)).toHaveAttribute("data-task-record", chart.id);
    // A long record reads to its end in the card's one scroller, never a
    // nested scroll surface inside the body.
    await click(recordCard(page).locator('[data-record-section="words"] > summary'));
    const scroller = recordCard(page).locator("[data-card-body]");
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);
    // The body frame now ends Info (INF-2261), below the opened words: an
    // undrawn frame there paints only once scrolled into view.
    await expectRecordBody(page);
    // The frame can report that it drew before Chromium applies the host's
    // new height to the child viewport. Measure the fit in the child itself.
    await expect
      .poll(
        () =>
          recordFrame(page)
            .locator("html")
            .evaluate((el) => el.scrollHeight - innerHeight),
        { message: "the task record fits in its frame without an inner scroller" },
      )
      .toBeLessThanOrEqual(0);
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("long-record-scrolled.png") });
    // Records are views of tasks: the only card kept is the answer.
    const persisted = await page.evaluate(() => window.infinitary.cards.list());
    expect(persisted.map((card) => card.title)).toEqual([MOCK_ANSWER_TITLE]);

    await page.keyboard.press("Escape");
    await expect(nowFrame(page).locator("[data-now-selected]")).toHaveCount(1);
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible();
    await page.getByRole("button", { name: "Previous card" }).click();
    await expect(recordCard(page)).toBeVisible();
    await expectRecordBody(page);
    await hideRecord(page).click();
    await expect(recordCard(page)).toHaveCount(0);
    await expect(nowFrame(page).locator("[data-now-selected]")).toHaveCount(0);
    await expect(character).toBeHidden();
    await cardLeave(page, page.locator("[data-response-card]")).click();
    await expect(character).toBeVisible();
    await expect(promptInput(page)).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("character-restored.png") });
  } finally {
    await launched.close();
  }
});
