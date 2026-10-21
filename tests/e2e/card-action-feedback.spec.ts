import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { unlandedWorkText } from "../../src/core/orchestrator/settleWords";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { REQUEST_COPY } from "../../src/preload/readableRequest";
import { purgedTasksText } from "../../src/renderer/src/settings/generalWords";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { settled } from "./layout";
import { pastePictures } from "./prompt";
import { feedLineOf, taskKey } from "./rails";
import { assertReadableSettingsFeedback, settingsFeedback } from "./settings";
import { cardReply, expectNoCard, shownCard } from "./stack";
import { setThemeViaSettings } from "./theme";

const REQUEST_REASON = "The request could not be completed.";

/** The titles of the cards this spec seeds, where it seeds them and where it finds them. */
const CHOOSE_TITLE = "Choose a course";
const SETTLE_TITLE = "Ready to settle";
const CLOSED_CHOICE_TITLE = "A choice left on closed work";
const REFUSAL_TITLE = "Review the next choice";
const ANSWER_TITLE = "The setting is available";
/** The task whose working copy holds edits that were never merged. */
const UNLANDED_TASK_TITLE = "Keep the unlanded work";

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

for (const theme of ["dark", "light"] as const) {
  test(`pending card actions acknowledge at the first frame without shifting the row (${theme})`, async () => {
    const userDataDir = scratchDir("infinitary-pending-");
    const db = openDatabase(userDataDir);
    new CardStore(db).upsert({
      id: "pending",
      title: CHOOSE_TITLE,
      author: "firstmate",
      priority: 50,
      meta: "firstmate",
      // Firstmate 3000's hook, as a card saved before the Infinitary rename writes it.
      body: '<p>Choose what happens next.</p><button data-fm-action="choose">Choose</button>',
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "choose", label: "Choose" },
        { id: "wait", label: "Wait" },
      ],
    });
    db.close();
    const launched = await launchApp({ userDataDir });
    try {
      const { app, page } = launched;
      if (theme === "light") await setThemeViaSettings(page, "light");
      await holdRequest(app, "inf:cards:act", {});
      const choose = page.getByRole("button", { name: "Choose", exact: true });
      const keep = page.getByRole("button", { name: "Wait", exact: true });
      const bodyAction = cardBody(page, CHOOSE_TITLE).getByRole("button", {
        name: "Choose",
        exact: true,
      });
      await expect(bodyAction).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      // Closing Settings replays the stage's entrance, so the row is measured
      // once it holds still: the click, not that move, must leave it in place.
      const [before, siblingBefore] = await settled(page, () =>
        Promise.all([choose.boundingBox(), keep.boundingBox()]),
      );
      const committed = await choose.evaluate(async (button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click(); // Same-tick click, before React paints.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          disabled: (button as HTMLButtonElement).disabled,
          busy: button.getAttribute("aria-busy"),
        };
      });
      expect(committed).toEqual({ disabled: true, busy: "true" });
      const pending = page.getByRole("button", { name: "Working...", exact: true });
      await expect(pending).toBeDisabled();
      await expect(keep).toBeDisabled();
      expect(await pending.boundingBox()).toEqual(before);
      expect(await keep.boundingBox()).toEqual(siblingBefore);
      // Body actions ride the same store guard as the host's footer.
      await bodyAction.evaluate((button) => (button as HTMLButtonElement).click());
      await expect.poll(() => calls(app)).toBe(1);
      await page.screenshot({ path: test.info().outputPath(`card-pending-${theme}.png`) });
      await reply(app, true);
      await expect(page.getByRole("alert")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`card-refusal-${theme}.png`) });
      await expect(page.getByRole("alert")).toHaveText(REQUEST_REASON);
      await expect(choose).toBeEnabled();
      await expect(keep).toBeEnabled();
      // Retrying an unaccepted request works. Receipt alone closes it, even
      // with no cards push from this controlled IPC handler.
      await choose.click();
      await expect.poll(() => calls(app)).toBe(2);
      await reply(app);
      // The stand-in handler never reached the core, which still holds the
      // card: the stage let it go.
      await expect(shownCard(page, CHOOSE_TITLE)).toHaveCount(0);
    } finally {
      await launched.close();
    }
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`quota refresh and purge commit in place, refuse duplicate clicks, and show failures (${theme})`, async () => {
    // The Intelligence header's meta and Refresh render only once a snapshot
    // has providers (docs/first-launch.md), so the run carries one measured
    // row through the fixture seam; no account is needed for the header.
    const fixtureDir = scratchDir("infinitary-quota-fixture-");
    writeFileSync(
      join(fixtureDir, "snapshot.json"),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        fetchedAt: Date.now(),
        providers: [
          {
            provider: "codex",
            label: "Codex",
            accountId: "acct_feedback",
            accountLabel: "Personal",
            status: "ok",
            stale: false,
            windows: [],
          },
        ],
      }),
    );
    const launched = await launchApp({ env: { INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir } });
    try {
      const { app, page } = launched;
      const snapshot = await page.evaluate(() => window.infinitary.quota.refresh());
      await holdRequest(app, "inf:quota:refresh", snapshot);
      await setThemeViaSettings(page, theme, { close: false });
      await page.getByRole("tab", { name: "Intelligence" }).click();
      const refresh = page.getByRole("button", { name: "Refresh", exact: true });
      await expect(refresh).toBeVisible();
      const before = await refresh.boundingBox();
      const disabled = await refresh.evaluate(async (button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return (button as HTMLButtonElement).disabled;
      });
      expect(disabled).toBe(true);
      const refreshing = page.getByRole("button", { name: "Refreshing...", exact: true });
      await expect(refreshing).toBeDisabled();
      expect(await refreshing.boundingBox()).toEqual(before);
      await expect.poll(() => calls(app)).toBe(1);
      await reply(app, true);
      const quotaFeedback = settingsFeedback(page, "subscriptions");
      await assertReadableSettingsFeedback(quotaFeedback, REQUEST_REASON);
      await page.screenshot({ path: test.info().outputPath(`quota-${theme}.png`) });
      const quotaMessage = await quotaFeedback.textContent();
      await expect(refresh).toBeEnabled();
      await refresh.click();
      await expect.poll(() => calls(app)).toBe(2);
      await reply(app);
      await expect(refresh).toBeEnabled();
      await expect(quotaFeedback).toHaveCount(0);

      // Refresh also reloads the model list. A failure in that follow-on read
      // must not reintroduce the transport wrapper after quota itself succeeds.
      await app.evaluate(({ ipcMain }, reason) => {
        ipcMain.removeHandler("inf:models:slots");
        ipcMain.handle("inf:models:slots", () => {
          throw new TypeError(reason);
        });
      }, REQUEST_REASON);
      await refresh.click();
      await expect.poll(() => calls(app)).toBe(3);
      await reply(app);
      await assertReadableSettingsFeedback(quotaFeedback, REQUEST_REASON);
      const modelsMessage = await quotaFeedback.textContent();
      await expect(refresh).toBeEnabled();

      const purgedTasks = 2;
      await holdRequest(app, "inf:retention:purge", { purgedTasks });
      await page.getByRole("tab", { name: "General", exact: true }).click();
      await page.getByRole("button", { name: "Purge", exact: true }).click();
      expect(await calls(app)).toBe(0); // Arming is not destructive.
      const confirm = page.getByRole("button", { name: "Confirm purge", exact: true });
      const purgeBefore = await confirm.boundingBox();
      const purging = await confirm.evaluate(async (button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return (button as HTMLButtonElement).disabled;
      });
      expect(purging).toBe(true);
      const pending = page.getByRole("button", { name: "Purging...", exact: true });
      await expect(pending).toBeDisabled();
      expect(await pending.boundingBox()).toEqual(purgeBefore);
      await expect.poll(() => calls(app)).toBe(1);
      await reply(app, true);
      const purgeFeedback = settingsFeedback(page, "purge");
      await assertReadableSettingsFeedback(purgeFeedback, REQUEST_REASON);
      await page.screenshot({ path: test.info().outputPath(`purge-${theme}.png`) });
      const purgeMessage = await purgeFeedback.textContent();
      await page.getByRole("button", { name: "Purge", exact: true }).click();
      await page.getByRole("button", { name: "Confirm purge", exact: true }).click();
      await expect.poll(() => calls(app)).toBe(2);
      await reply(app);
      await expect(
        page.locator('[data-setting="purge-task-data"]').getByText(purgedTasksText(purgedTasks), {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Purge", exact: true })).toBeEnabled();
      writeFileSync(
        test.info().outputPath(`refresh-purge-${theme}.json`),
        JSON.stringify(
          { quotaMessage, modelsMessage, purgeMessage, retry: await purgeFeedback.textContent() },
          null,
          2,
        ),
      );
    } finally {
      await launched.close();
    }
  });
}

test("account connection and sign-in failures keep readable reasons and retryable controls", async () => {
  const userDataDir = scratchDir("infinitary-settings-accounts-");
  const accountId = "acct_settings_feedback";
  // A truthful disconnected account: the row exists, but no key has been saved.
  mkdirSync(join(userDataDir, "accounts", "openrouter", accountId), { recursive: true });
  writeFileSync(
    join(userDataDir, "accounts", "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: accountId,
          providerId: "openrouter",
          kind: "api_key",
          label: "Personal",
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
  );
  const launched = await launchApp({ userDataDir });
  try {
    const { app, page } = launched;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const feedback = settingsFeedback(page, "subscriptions");
    const messages: Record<string, string | null> = {};
    for (const [channel, control, name] of [
      ["inf:accounts:add", page.getByRole("button", { name: "Connect Codex", exact: true }), "add"],
      [
        "inf:accounts:sign-in",
        page
          .locator(`[data-account-row="${accountId}"]`)
          .getByRole("button", { name: "Sign in", exact: true }),
        "sign-in",
      ],
    ] as const) {
      await holdRequest(app, channel, null, { message: REQUEST_REASON, name: "TypeError" });
      await expect(control).toBeEnabled();
      await control.click();
      await expect.poll(() => calls(app)).toBe(1);
      await reply(app, true);
      await assertReadableSettingsFeedback(feedback, REQUEST_REASON);
      messages[name] = await feedback.textContent();
      await expect(control).toBeEnabled();
      await page.screenshot({ path: test.info().outputPath(`account-${name}.png`) });
      // The first refusal did not strand the sign-in control.
      await control.click();
      await expect.poll(() => calls(app)).toBe(2);
      await expect(feedback).toHaveCount(0);
      await reply(app, true);
      await assertReadableSettingsFeedback(feedback, REQUEST_REASON);
      await expect(control).toBeEnabled();

      await holdRequest(app, channel, null, { message: "", name: "Error" });
      await control.click();
      await expect.poll(() => calls(app)).toBe(1);
      await reply(app, true);
      await assertReadableSettingsFeedback(feedback, REQUEST_COPY[channel].fallback);
      messages[`${name}-fallback`] = await feedback.textContent();
      await expect(control).toBeEnabled();
      await page.screenshot({ path: test.info().outputPath(`account-${name}-fallback.png`) });
    }
    writeFileSync(
      test.info().outputPath("account-messages.json"),
      JSON.stringify(messages, null, 2),
    );
  } finally {
    await launched.close();
  }
});

/** Real restored card, real dirty git worktree, real IPC, and the persisted feed. */
test("a refused discard acknowledges the click and explains why after the card is gone", async () => {
  const userDataDir = scratchDir("infinitary-action-");
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const git = (...args: string[]) => execFileSync("git", args);
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", "fm/task-feedback", worktreeDir);
  writeFileSync(join(worktreeDir, "unlanded.txt"), "Keep this work.\n");
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
  new CardStore(db).upsert({
    id: "card-feedback",
    taskId: "feedback",
    title: SETTLE_TITLE,
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
  db.close();

  let launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    const discard = page.getByRole("button", { name: "Discard", exact: true });
    await expect(discard).toBeVisible();
    // The pending state is set in the click, then React paints it. One
    // animation frame is not enough when the renderer is busy: release run
    // 37220724871 and a solo run on that commit both saw the button still
    // enabled at that frame, while the refusal itself arrived. Wait for the
    // acknowledgement, and fail if it never comes.
    await discard.evaluate((button) => (button as HTMLButtonElement).click());
    await expect
      .poll(async () => {
        if ((await discard.count()) === 0) return true;
        return discard.isDisabled();
      })
      .toBe(true);
    await expectNoCard(page, SETTLE_TITLE);
    // The working copy holds the spec's uncommitted file and no commit of
    // its own, and no project ships it elsewhere, so the way on is a merge
    // of the branch.
    const refusal = {
      type: "firstmate_note",
      text: unlandedWorkText(
        { key: await taskKey(page, UNLANDED_TASK_TITLE), title: UNLANDED_TASK_TITLE },
        { dirty: true, unlandedCommits: 0 },
        "land",
      ),
    } as const;
    await expect.soft(feedLineOf(page, refusal)).toBeVisible();
    expect(existsSync(join(worktreeDir, "unlanded.txt"))).toBe(true);
    expect((await page.evaluate(() => window.infinitary.tasks.detail("feedback")))?.status).toBe(
      "active",
    );

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
      await page.getByRole("button", { name: "Send reply", exact: true }).click();
      await expect.poll(() => calls(app)).toBe(1);
      // A lone card stays where it is while its reply is in flight
      // (docs/card-threads.md); the held send control is what shows it left.
      await expect(title).toBeVisible();
      await expect(page.getByRole("button", { name: "Send reply", exact: true })).toBeDisabled();
      await reply(app, true);
      await expect(page.getByRole("alert")).toHaveText(REQUEST_REASON);
      await expect(title).toBeVisible();
      await expect(composer.field).toHaveValue(draft);
      await expect(composer.pictures).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Send reply", exact: true })).toBeEnabled();
      expect(
        (await page.evaluate(() => window.infinitary.cards.thread("readable-refusal"))).messages,
      ).toEqual([]);
      await page.screenshot({ path: test.info().outputPath("card-reply-refusal.png") });

      await page.getByRole("button", { name: "Send reply", exact: true }).click();
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
