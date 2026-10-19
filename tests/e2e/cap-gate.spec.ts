import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { regionShot } from "./pictures";
import { dockRegion, nowFrame, pressRow, recordFrame } from "./rails";

/**
 * A round cap is a hold on the task's gate (the primitives review, P2; the
 * sibling of report-sort.spec.ts). Two crewmates hit the CI cap and the
 * app closed. One already has the Firstmate's decision card on it: that
 * task is the captain's, so it is listed under waiting on you and a click
 * brings the card forward. The other has no card yet: it is held - the
 * Firstmate owes the card - so it stays working, and its record shows its
 * crewmate's latest report as the reason rather than looking free (FI3-702).
 */

const HEAD = "abc1234def5678";
const REPORT = "The gauge test failed the checks three times.";

test("a capped task with its decision card up waits on the captain; one without is held", async () => {
  const userDataDir = scratchDir("infinitary-cap-gate-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  for (const [id, title] of [
    ["capped-card", "Fix the meter test"],
    ["capped-alone", "Fix the gauge test"],
  ] as const) {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, { id, title, status: "completed", worktreeDir, outcome: REPORT });
    tasks.recordDelivery(id, {
      headSha: HEAD,
      ci: "red",
      ciRounds: 3,
      ciRedHead: HEAD,
      ciCapAt: Date.now(),
    });
  }
  new CardStore(db).upsert({
    id: "card-fm-cap-1",
    taskId: "capped-card",
    author: "firstmate",
    priority: 30,
    title: "Retry the meter fix?",
    meta: "firstmate",
    body: "<p>The checks failed three times on this task.</p><ul><li>Retry, try a stronger model, or discard.</li></ul>",
    actions: [{ id: "retry", label: "Retry", variant: "primary", default: true }],
    status: "ready",
    createdAt: Date.now(),
  });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    const flagsOf = (id: string) =>
      page.evaluate(async (taskId) => {
        const board = await window.infinitary.tasks.board();
        const task = board.tasks.find((entry) => entry.id === taskId);
        return task ? { key: task.key, ...task.flags, card: task.waitingCardId } : null;
      }, id);
    await expect
      .poll(() => flagsOf("capped-card"))
      .toMatchObject({ held: true, needsYou: true, card: "card-fm-cap-1" });
    await expect
      .poll(() => flagsOf("capped-alone"))
      .toMatchObject({ held: true, needsYou: false, card: null });
    const carded = (await flagsOf("capped-card"))?.key ?? "";
    const alone = (await flagsOf("capped-alone"))?.key ?? "";

    const frame = nowFrame(page);
    await expect(
      frame.locator('[data-now-group="waiting"]').locator(`[data-now-key="${carded}"]`),
    ).toBeVisible();
    await expect(
      frame.locator('[data-now-group="working"]').locator(`[data-now-key="${alone}"]`),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath("cap-gate-now-panel.png") });

    // The held task's record gives its crewmate's own reason, not a free look.
    await pressRow(page, alone);
    await expect(recordFrame(page).locator("[data-record-attention-guidance]")).toHaveText(REPORT);
    await expect(
      recordFrame(page).locator('[data-record-section="timeline"] > summary'),
    ).toBeVisible();
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== "running"),
    );
    await page.screenshot({ path: test.info().outputPath("cap-gate-record.png") });
  } finally {
    await launched.close();
  }
});

// Accepted INF-166 A: a qualifying review cap belongs to the first mate,
// every time; the captain's board must not call that task held or waiting.
// Real saved delivery facts and the boot reconciler own this UI fact.
test("a first-mate review cap stays working without a captain gate after launch", async () => {
  const userDataDir = scratchDir("infinitary-delegated-cap-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const worktreeDir = join(userDataDir, "worktrees", "review-wording");
  mkdirSync(worktreeDir, { recursive: true });
  seedTask(tasks, {
    id: "review-wording",
    title: "Fix the review wording",
    status: "completed",
    worktreeDir,
    outcome: "The reviewer asks to say likely in the pull request description.",
  });
  tasks.recordDelivery("review-wording", {
    headSha: HEAD,
    reviewRounds: 3,
    reviewCapAt: Date.now(),
    reviewCapOwner: "firstmate",
    reviewVerdict: "findings",
    reviewRoundSha: HEAD,
  });
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    const state = () =>
      page.evaluate(async () => {
        const board = await window.infinitary.tasks.board();
        const task = board.tasks.find((entry) => entry.id === "review-wording");
        return task ? { key: task.key, ...task.flags, card: task.waitingCardId } : null;
      });
    await expect.poll(state).toMatchObject({ held: false, needsYou: false, card: null });
    const key = (await state())?.key ?? "";
    await expect(
      nowFrame(page).locator('[data-now-group="working"]').locator(`[data-now-key="${key}"]`),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await regionShot(dockRegion(page, "now"), test.info().outputPath("delegated-cap-working.png"));
  } finally {
    await launched.close();
  }
});
