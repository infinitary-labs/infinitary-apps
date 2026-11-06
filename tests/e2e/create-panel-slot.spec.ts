import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { CREATE_PANEL_DRAFT, CREATE_PANEL_SLOT_ID } from "../../src/shared/createPanelSlot";
import { scratchDir } from "../helpers/scratchDirs";
import { MOCK_PANEL_ID, MOCK_PANEL_TITLE } from "./crewScripts";
import { type LaunchedApp, launchApp } from "./launch";
import { startMockProvider } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  ANSWER_TASK_PROMPT_MARKER,
  answerTask,
  MOCK_ANSWER_ACTION_LABEL,
} from "./scenarios/answerTask";
import { PERSONAL_REMOVE_PROMPT_MARKER, personalPanels } from "./scenarios/personalPanels";
import { regionAfter } from "./windowKeys";

/**
 * The create-your-own-panel slot (docs/first-launch.md): once three of the
 * captain's crewmates have finished their tasks, an empty slot at the top
 * of the left rail invites a panel of their own. Its click starts the ask
 * in the message box; the panel built from it lands where the slot was, and
 * the slot leaves while that panel exists. The rule's facts are
 * createPanelSlot.test.ts's, the click's createPanelSlotStore.test.ts's,
 * and "hide it" core.projects.test.ts's.
 */

const slot = (page: Page) => page.locator("[data-create-panel-slot]");

/** The window has read the first-run record, so an absent slot is a decision, not a wait. */
async function firstRunRead(page: Page): Promise<number | null> {
  return page.evaluate(() =>
    window.infinitary.app.firstRun().then((record) => record.thirdCrewmateDoneAt ?? null),
  );
}

/** A profile whose crewmates have already finished `count` tasks, merged. */
function withFinishedCrewmates(count: number): string {
  const userDataDir = scratchDir("infinitary-create-panel-slot-");
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    for (let n = 1; n <= count; n++) {
      seedTask(tasks, { id: `done-work-${n}`, title: `Finished work ${n}`, status: "completed" });
      tasks.close(`done-work-${n}`, { status: "done", reason: "merged", actor: "captain" });
    }
  } finally {
    db.close();
  }
  return userDataDir;
}

test("a profile shows no slot until its third crewmate finishes, which brings it at once", async () => {
  test.setTimeout(2 * 60_000);
  const launched = await launchApp({
    scenarios: [personalPanels, answerTask],
    userDataDir: withFinishedCrewmates(2),
    withMockProvider: true,
  });
  try {
    const { page } = launched;
    await expect(page.locator('[data-side-panel="activity"]')).toBeVisible();
    expect(await firstRunRead(page)).toBeNull();
    await expect(slot(page)).toHaveCount(0);
    // A plain message is answered by the Firstmate and filed as a question
    // closed done: no crewmate worked on it, so it does not count.
    const input = promptInput(page);
    await input.click();
    await input.fill("hello there");
    await input.press("Enter");
    await expect
      .poll(async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        return board.tasks.some((task) => task.kind === "question" && task.status === "done");
      })
      .toBe(true);
    expect(await firstRunRead(page)).toBeNull();
    await expect(slot(page)).toHaveCount(0);
    // A third crewmate finishes - its answer chosen on its card - and the
    // slot comes without a relaunch.
    await input.click();
    await input.fill(`${ANSWER_TASK_PROMPT_MARKER} why the meter idles`);
    await input.press("Enter");
    const answer = page.getByRole("button", { name: MOCK_ANSWER_ACTION_LABEL });
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(slot(page)).toHaveCount(0);
    await answer.click();
    await expect(slot(page)).toBeVisible({ timeout: 20_000 });
    expect(await firstRunRead(page)).not.toBeNull();
  } finally {
    await launched.close();
  }
});

test("after three finished crewmates the slot starts the ask, leaves for the panel it built, and comes back until its Hide", async () => {
  // One story: each step starts where the last left the slot and the panel.
  test.setTimeout(4 * 60_000);
  const userDataDir = withFinishedCrewmates(3);
  const mockProvider = await startMockProvider({ scenarios: [personalPanels, answerTask] });
  let live: LaunchedApp = await launchApp({ userDataDir, reuseMockProvider: mockProvider });
  const panel = () => live.page.locator(`[data-side-panel="${MOCK_PANEL_ID}"]`);
  const relaunch = async () => {
    await live.close();
    live = await launchApp({ userDataDir, reuseMockProvider: mockProvider });
    await expect(live.page.locator('[data-side-panel="activity"]')).toBeVisible();
    expect(await firstRunRead(live.page)).not.toBeNull();
  };
  try {
    await test.step("a profile whose crewmates already finished three tasks sees the slot at the top of the left rail", async () => {
      const { page } = live;
      await expect(slot(page)).toBeVisible();
    });

    await test.step("from the keyboard it starts the ask, keeping the words already typed", async () => {
      const { app, page } = live;
      const input = promptInput(page);
      await input.click();
      await input.fill(MOCK_PANEL_TITLE);
      // F6 from the message box goes round to the window's first part.
      expect(await regionAfter(app, page, "main-message", "F6")).toBe("panel");
      const ask = slot(page).locator("[data-create-panel-slot-ask]");
      await expect(ask).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(`${CREATE_PANEL_DRAFT}${MOCK_PANEL_TITLE}`);
      await expect
        .poll(() => input.evaluate((field: HTMLTextAreaElement) => field.selectionStart))
        .toBe(CREATE_PANEL_DRAFT.length);
      // The slot stays until a panel exists.
      await expect(slot(page)).toBeVisible();
    });

    await test.step("sent, the ask builds a panel where the slot was, and the slot leaves", async () => {
      const { page } = live;
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(panel()).toBeVisible({ timeout: 45_000 });
      await expect(slot(page)).toHaveCount(0);
      // The crewmate reports and its task closes: the running dot goes.
      await expect(panel().locator("[data-side-panel-running]")).toHaveCount(0, {
        timeout: 30_000,
      });
    });

    await test.step("a relaunch keeps the slot away while that panel exists", async () => {
      await relaunch();
      await expect(panel()).toBeVisible({ timeout: 45_000 });
      await expect(slot(live.page)).toHaveCount(0);
    });

    await test.step("removing the panel brings the slot back, and its Hide keeps it away for good", async () => {
      const { page } = live;
      const input = promptInput(page);
      await input.click();
      await input.fill(`${PERSONAL_REMOVE_PROMPT_MARKER}${MOCK_PANEL_ID}`);
      await input.press("Enter");
      await expect(panel()).toHaveCount(0, { timeout: 30_000 });
      await expect(slot(page)).toBeVisible();
      await slot(page).getByRole("button", { name: "Hide" }).click();
      await expect(slot(page)).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => window.infinitary.settings.getLayout()))
        .toMatchObject({ hiddenPanels: { [CREATE_PANEL_SLOT_ID]: true } });
      await relaunch();
      await expect(slot(live.page)).toHaveCount(0);
    });
  } finally {
    await live.close();
    await mockProvider.close();
  }
});
