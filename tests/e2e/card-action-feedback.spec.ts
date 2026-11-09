import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { decisionDropRefusal } from "../../src/core/orchestrator/settleWords";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { keptRefFor } from "../../src/core/workspace/workspaceService";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { pastePictures } from "./prompt";
import { feedLineOf, taskKey } from "./rails";
import { cardReply, expectNoCard, expectUpdateSeen, shownCard } from "./stack";

const REQUEST_REASON = "The request could not be completed.";

/** The titles of the cards this spec seeds, where it seeds them and where it finds them. */
const SETTLE_TITLE = "Ready to settle";
const CLOSED_CHOICE_TITLE = "A choice left on closed work";
const REFUSAL_TITLE = "Review the next choice";
const ANSWER_TITLE = "The setting is available";
/** The task whose working copy holds edits that were never merged. */
const UNLANDED_TASK_TITLE = "Keep the unlanded work";
/** A decision, which holds no crew work for a discard to drop. */
const DECISION_TASK_TITLE = "Pick the harbour";

type HeldRequest = {
  calls: number;
  resolve: () => void;
  reject: () => void;
};
type ProbeHost = typeof globalThis & { feedbackRequest: HeldRequest };

/** Controlled IPC latency, not a timer: tests decide exactly when the host replies. */
async function holdRequest(
  app: ElectronApplication,
  channel: string,
  result: unknown,
  failure = { message: REQUEST_REASON, name: "Error" },
) {
  await app.evaluate(
    ({ ipcMain }, { channel, result, failure }) => {
      const probe: HeldRequest = { calls: 0, resolve: () => {}, reject: () => {} };
      (globalThis as ProbeHost).feedbackRequest = probe;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        probe.calls += 1;
        return new Promise((resolve, reject) => {
          probe.resolve = () => resolve(result);
          probe.reject = () => {
            const error = new Error(failure.message);
            error.name = failure.name;
            reject(error);
          };
        });
      });
    },
    { channel, result, failure },
  );
}

function calls(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as ProbeHost).feedbackRequest.calls);
}

async function reply(app: ElectronApplication, fail = false) {
  await app.evaluate((_electron, fail) => {
    const probe = (globalThis as ProbeHost).feedbackRequest;
    if (fail) probe.reject();
    else probe.resolve();
  }, fail);
}

/** A Discard settle card on a task, as the first mate declares it. */
function discardCard(
  db: ReturnType<typeof openDatabase>,
  id: string,
  taskId: string,
  title: string,
) {
  new CardStore(db).upsert({
    id,
    taskId,
    title,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    body: "<p>The work is ready for your decision.</p>",
    status: "ready",
    createdAt: Date.now(),
    // The discard is a declared effect (cards/tasks/agents P1): the host runs
    // it, and refuses it, on the click - closing the card would be keep.
    actions: [
      {
        id: "discard",
        label: "Discard",
        danger: true,
        effect: { kind: "settle", mode: "discard" },
      },
    ],
  });
}

/**
 * Click the card's Discard and wait for the acknowledgement. The pending
 * state is set in the click, then React paints it. One animation frame is
 * not enough when the renderer is busy: release run 37220724871 and a solo
 * run on that commit both saw the button still enabled at that frame, while
 * the outcome itself arrived. Wait for the acknowledgement, and fail if it
 * never comes.
 */
async function clickDiscard(page: Page) {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await expect(discard).toBeVisible();
  await discard.evaluate((button) => (button as HTMLButtonElement).click());
  await expect
    .poll(async () => {
      if ((await discard.count()) === 0) return true;
      return discard.isDisabled();
    })
    .toBe(true);
}

/**
 * The captain's Discard is the one drop (INF-3169's piece 4, the captain's
 * "Also fold the three into one drop"): it passes the unmerged-work hold the
 * first mate meets, drops the task, and saves the edits it never merged on
 * the task's kept ref before the working copy goes. Real restored card, real
 * dirty git worktree, real IPC, and the persisted record.
 */
test("the captain's Discard drops unmerged work and keeps its edits saved", async () => {
  const userDataDir = scratchDir("infinitary-action-");
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", "fm/task-feedback", worktreeDir);
  const work = "Keep this work.\n";
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(worktreeDir, "unlanded.txt"), work);
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "feedback",
    title: UNLANDED_TASK_TITLE,
    status: "idle",
    repoDir,
    worktreeDir,
    branch: "fm/task-feedback",
  });
  discardCard(db, "card-feedback", "feedback", SETTLE_TITLE);
  db.close();

  let launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await clickDiscard(page);
    await expectNoCard(page, SETTLE_TITLE);
    const dropped = { status: "dropped", closedReason: "discarded" };
    await expect
      .poll(async () => {
        const task = await page.evaluate(() => window.infinitary.tasks.detail("feedback"));
        return { status: task?.status, closedReason: task?.closedReason };
      })
      .toEqual(dropped);
    // The record closes first; the working copy is retired after it, and
    // only once its work is saved. Its removal is that retirement's end.
    await expect.poll(() => existsSync(worktreeDir)).toBe(false);
    // The edits that were never merged are saved on the task's kept ref.
    expect(git("-C", repoDir, "show", `${keptRefFor("feedback")}:unlanded.txt`)).toBe(work);

    await launched.close();
    launched = await launchApp({ userDataDir });
    await expectNoCard(launched.page, SETTLE_TITLE);
    const restored = await launched.page.evaluate(() => window.infinitary.tasks.detail("feedback"));
    expect({ status: restored?.status, closedReason: restored?.closedReason }).toEqual(dropped);
    expect(git("-C", repoDir, "show", `${keptRefFor("feedback")}:unlanded.txt`)).toBe(work);
  } finally {
    await launched.close();
  }
});

/**
 * A drop the one drop still refuses: a decision holds no crew work, so the
 * captain's Discard on its card is refused, and the refusal is said on the
 * feed after the card is gone. Real restored card, real IPC, and the
 * persisted feed.
 */
test("a refused discard acknowledges the click and explains why after the card is gone", async () => {
  const userDataDir = scratchDir("infinitary-action-refused-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "choice", title: DECISION_TASK_TITLE, kind: "decision", status: "idle" });
  discardCard(db, "card-choice", "choice", SETTLE_TITLE);
  db.close();

  let launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    const before = await page.evaluate(() => window.infinitary.tasks.detail("choice"));
    await clickDiscard(page);
    await expectNoCard(page, SETTLE_TITLE);
    const refusal = {
      type: "firstmate_note",
      text: decisionDropRefusal(await taskKey(page, DECISION_TASK_TITLE)),
    } as const;
    await expect(feedLineOf(page, refusal)).toBeVisible();
    const after = await page.evaluate(() => window.infinitary.tasks.detail("choice"));
    expect({ status: after?.status, closedAt: after?.closedAt }).toEqual({
      status: before?.status,
      closedAt: before?.closedAt,
    });

    await launched.close();
    launched = await launchApp({ userDataDir });
    await expectNoCard(launched.page, SETTLE_TITLE);
    await expect(feedLineOf(launched.page, refusal)).toBeVisible();
  } finally {
    await launched.close();
  }
});

test("a refused choice on a closed task leaves its open card on screen and runs no effect", async () => {
  const userDataDir = scratchDir("infinitary-unavailable-choice-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "closed", title: "Closed work", status: "cancelled" });
  new CardStore(db).upsert({
    id: "closed-choice",
    taskId: "closed",
    author: "firstmate",
    priority: 30,
    title: CLOSED_CHOICE_TITLE,
    meta: "closed work",
    body: "<p>This work has already closed.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [{ id: "open", label: "Open settings", effect: { kind: "open", target: "settings" } }],
  });
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await expect(shownCard(page, CLOSED_CHOICE_TITLE)).toBeVisible();
    await expectUpdateSeen(page, "closed-choice");
    const before = await page.evaluate(() => window.infinitary.tasks.detail("closed"));
    expect(before.waitingCardId).toBeNull();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeHidden();
    await expect(shownCard(page, CLOSED_CHOICE_TITLE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Open settings", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.infinitary.tasks.detail("closed"))).toEqual(before);
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).some(
        (card) => card.id === "closed-choice",
      ),
    ).toBe(true);
    expect(
      (await page.evaluate(() => window.infinitary.projects.list()))[0]?.counts.waitingOnYou,
    ).toBe(0);
    await page.screenshot({ path: test.info().outputPath("ready-choice-refused.png") });
  } finally {
    await launched.close();
  }
});

test("transported reply and embedded-action refusals keep readable reasons and unsent drafts", async () => {
  const userDataDir = scratchDir("infinitary-card-refusal-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "readable-refusal",
    title: REFUSAL_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    body: `<p>Your choice stays here if it cannot be sent.</p>
      <button id="choose">Choose in the card</button><p data-frame-refusal></p>
      <script>document.getElementById('choose').onclick = function () {
        fm.action('choose').catch(function (error) {
          document.querySelector('[data-frame-refusal]').textContent = error.message;
        });
      };</script>`,
    status: "ready",
    createdAt: Date.now(),
    actions: [{ id: "choose", label: "Choose" }],
  });
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { app, page } = launched;
    const title = shownCard(page, REFUSAL_TITLE);
    await expect(title).toBeVisible();

    await test.step("real core refusals cross the transport without decoration", async () => {
      const reasons = await page.evaluate(async () => {
        const messages: string[] = [];
        for (const refuse of [
          () =>
            window.infinitary.cards.act("readable-refusal", "choose", "chrome", { answers: [{}] }),
          () => window.infinitary.cards.reply("missing-card", "Can you explain this?"),
        ]) {
          try {
            await refuse();
          } catch (error) {
            messages.push((error as Error).message);
          }
        }
        return messages;
      });
      expect(reasons).toHaveLength(2);
      expect(reasons[0]).toMatch(/answers.*could not be read/);
      expect(reasons[1]).toMatch(/Unknown card/);
      for (const reason of reasons) expect(reason).not.toMatch(/inf:cards:|remote method|^Error:/);
      expect(
        (await page.evaluate(() => window.infinitary.cards.thread("readable-refusal"))).messages,
      ).toEqual([]);
      await expect(title).toBeVisible();
      writeFileSync(
        test.info().outputPath("card-refusal-reasons.json"),
        JSON.stringify(reasons, null, 2),
      );
    });

    await test.step("a rejected embedded choice gets the same clean transport reason", async () => {
      await holdRequest(app, "inf:cards:act", {});
      const frame = cardBody(page, REFUSAL_TITLE);
      await frame
        .getByRole("button", { name: "Choose in the card", exact: true })
        .evaluate((button) => (button as HTMLButtonElement).click());
      await expect.poll(() => calls(app)).toBe(1);
      await reply(app, true);
      await expect(frame.locator("[data-frame-refusal]")).toHaveText(REQUEST_REASON);
      await expect(title).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose", exact: true })).toBeEnabled();
      await page.screenshot({ path: test.info().outputPath("card-frame-refusal.png") });
    });

    await test.step("a rejected reply keeps its lone card with words and pictures intact", async () => {
      await holdRequest(app, "inf:cards:reply", { cardId: "readable-refusal", messages: [] });
      const draft = "Can you explain the other choice?";
      const composer = cardReply(page);
      await composer.field.fill(draft);
      await pastePictures(composer.field, [{ name: "choice.png" }]);
      await expect(composer.pictures).toHaveCount(1);
      await cardReply(page).send.click();
      await expect.poll(() => calls(app)).toBe(1);
      // A lone card stays where it is while its reply is in flight
      // (docs/card-threads.md); the held send control is what shows it left.
      await expect(title).toBeVisible();
      await expect(cardReply(page).send).toBeDisabled();
      await reply(app, true);
      await expect(page.getByRole("alert")).toHaveText(REQUEST_REASON);
      await expect(title).toBeVisible();
      await expect(composer.field).toHaveValue(draft);
      await expect(composer.pictures).toHaveCount(1);
      await expect(cardReply(page).send).toBeEnabled();
      expect(
        (await page.evaluate(() => window.infinitary.cards.thread("readable-refusal"))).messages,
      ).toEqual([]);
      await page.screenshot({ path: test.info().outputPath("card-reply-refusal.png") });

      await cardReply(page).send.click();
      await expect.poll(() => calls(app)).toBe(2);
      await reply(app);
      await expect(composer.field).toHaveValue("");
      await expect(composer.pictures).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});

/** Deliberately invalid action id over real IPC; no acceptance/refusal handler is stubbed. */
test("an undeclared choice leaves its card and answer task open, then a declared choice still works", async () => {
  const userDataDir = scratchDir("infinitary-undeclared-choice-");
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = "fm/task-undeclared-answer";
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: initialize test project");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  const db = openDatabase(userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: "undeclared-answer",
    title: "Explain the setting",
    status: "idle",
    repoDir,
    worktreeDir,
    branch,
    gate: { kind: "captain", ref: "card-undeclared-answer-setting" },
    outcome: "The answer is ready for your choice.",
    shape: { kind: "research", kind_source: "classifier:test", deliverable: "answer" },
  });
  new CardStore(db).upsert({
    id: "card-undeclared-answer-setting",
    taskId: "undeclared-answer",
    author: "crewmate",
    priority: 30,
    title: ANSWER_TITLE,
    meta: "crewmate 1",
    body: "<p>The setting is available in Settings.</p><p>Your answer stays here until you choose.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "open",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
  });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const title = shownCard(page, ANSWER_TITLE);
    const open = page.getByRole("button", { name: "Open settings", exact: true });
    await expect(title).toBeVisible();
    await expectUpdateSeen(page, "card-undeclared-answer-setting");
    const before = await page.evaluate(async () => ({
      task: await window.infinitary.tasks.detail("undeclared-answer"),
      cards: await window.infinitary.cards.list(),
    }));
    expect(before.task).toMatchObject({
      status: "active",
      closedReason: null,
      deliverable: "answer",
      waitingCardId: "card-undeclared-answer-setting",
    });
    await page.screenshot({ path: test.info().outputPath("undeclared-choice-offer.png") });
    // Corrupt this one request, not the host response: the real action
    // interface receives a choice the shown card did not declare.
    await app.evaluate(({ ipcMain }) => {
      const channel = "inf:cards:act";
      const handlers = (
        ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
        }
      )._invokeHandlers;
      const act = handlers.get(channel);
      if (!act) throw new Error("The card action handler is missing.");
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, cardId, _actionId, ...args) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, act);
        const receipt = await act(event, cardId, "not-offered", ...args);
        (globalThis as typeof globalThis & { choiceReceipt?: unknown }).choiceReceipt = receipt;
        return receipt;
      });
    });
    await open.click();
    const receiptOf = () =>
      app.evaluate(
        () => (globalThis as typeof globalThis & { choiceReceipt?: unknown }).choiceReceipt,
      );
    await expect.poll(receiptOf).toBeDefined();
    const after = {
      receipt: await receiptOf(),
      ...(await page.evaluate(async () => ({
        task: await window.infinitary.tasks.detail("undeclared-answer"),
        cards: await window.infinitary.cards.list(),
      }))),
    };
    console.log(
      "Undeclared choice result:",
      JSON.stringify({
        receipt: after.receipt,
        task: {
          status: after.task.status,
          closedReason: after.task.closedReason,
          waitingCardId: after.task.waitingCardId,
        },
        cards: after.cards.map((card) => card.id),
      }),
    );
    await page.screenshot({ path: test.info().outputPath("undeclared-choice-refused.png") });
    writeFileSync(
      test.info().outputPath("undeclared-choice-state.json"),
      JSON.stringify({ before, after }, null, 2),
    );
    expect(after.receipt).toMatchObject({ refusal: expect.any(String) });
    expect(after.receipt).not.toHaveProperty("effect");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(title).toBeVisible();
    await expect(open).toBeEnabled();
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeHidden();
    expect(after.task).toEqual(before.task);
    expect(after.cards).toEqual(before.cards);
    expect(existsSync(worktreeDir)).toBe(true);

    // Refusal is not a resolution in persistence either.
    await page.reload();
    await expect(title).toBeVisible();
    expect(await page.evaluate(() => window.infinitary.tasks.detail("undeclared-answer"))).toEqual(
      before.task,
    );
    await open.click();
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.tasks.detail("undeclared-answer")))
      .toMatchObject({ status: "done", closedReason: "answered", waitingCardId: null });
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).some(
        (card) => card.id === "card-undeclared-answer-setting",
      ),
    ).toBe(false);
  } finally {
    await launched.close();
  }
});
