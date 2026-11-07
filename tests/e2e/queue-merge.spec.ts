import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { QUEUE_STATUS } from "../../src/core/forge/forge";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { QUEUE_HOW_TO_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { queueSettingsWarning } from "../../src/shared/repos";
import { PROJECT_DELIVERY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { heroShot, windowShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { projectRow } from "./projects";
import { readSavedData } from "./savedData";
import { shownEntry } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * INF-2435, piece 2 of the captain's approved swept-batch plan (INF-2430):
 * "The merge click, or a carried repair, writes infinitary/queue as waiting
 * on the approved version, and the kept click merges only once that status
 * passes", with INF-1275's pending merge shown on the card.
 *
 * Real git supplies the crewmate's commit; a disposable GitHub serves the
 * pull request, its passing check, the commit statuses and no workflow that
 * mentions the queue status, and records the one squash. INF-2886's approved
 * plan: the choice and the click read the project's workflows, so Settings
 * warns under Where changes go and the waiting note warns until the queue
 * first answers. The captain chooses the queue under Where changes go in
 * Settings -> Projects by keys while the completion card waits; the merge
 * click then marks the version and merges nothing; once the
 * project's queue sets the status to success, the kept click merges at that
 * version after the app starts again (its standing approvals run at start)
 * and the pending note leaves. Requires desktop Electron and local git; no
 * real sign-in or shared pull request.
 *
 * INF-2887, the captain's "Explain in Settings what the choice needs and
 * link to the how-to" with the label "Batched pull request": once chosen,
 * the row says the merge waits for the project's own queue workflow, its how-to
 * opens by keys, and its link opens GitHub's guide in the system browser.
 */
test("a queue-pr merge click marks its version, waits for the queue, then merges on the same click", async () => {
  const userDataDir = scratchDir("infinitary-queue-merge-");
  const taskId = "queuedmerge";
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = `fm/task-${taskId}`;
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project file this journey merges.
  writeFileSync(join(worktreeDir, "meter.txt"), "The meter reads on time.\n");
  git("-C", worktreeDir, "add", "meter.txt");
  git("-C", worktreeDir, "commit", "-m", "fix: read the meter on time");
  const headSha = git("-C", worktreeDir, "rev-parse", "HEAD").trim();

  const github = await startGitHubStub();
  github.servePull({ number: 82, title: "fix: read the meter on time" });
  github.headOf(() => headSha);
  github.setChecks([{ name: "unit-tests", status: "completed", conclusion: "success" }]);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'quick')",
  ).run("repo-meter", repoDir, "meter", Date.now(), "https://github.com/o/meter.git");
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: taskId,
    title: "Read the meter on time",
    status: "idle",
    repoId: "repo-meter",
    repoDir,
    worktreeDir,
    branch,
  });
  // The completion offer the host published once the pull request's checks passed at this version.
  const cardId = `card-${taskId}-1`;
  const offerId = "offer-queued";
  seedDelivery(tasks, taskId, {
    mode: "direct-pr",
    prNumber: 82,
    prUrl: "https://github.com/o/meter/pull/82",
    changeLabel: "#82",
    headSha,
    ci: "green",
    ciAt: Date.now(),
    completionOffers: [{ cardId, offerId, headSha, prNumber: 82, at: Date.now() }],
  });
  new CardStore(db).upsert({
    id: cardId,
    lifecycleId: "lifecycle-queued",
    offerId,
    taskId,
    author: "crewmate",
    priority: 30,
    title: "The meter reads on time",
    meta: "crewmate 1",
    body: "<p>The fix is ready.</p><p>It changes one file.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "merge",
        label: "Merge the pull request",
        variant: "primary",
        default: true,
        effect: { kind: "settle", mode: "merge" },
      },
    ],
  });
  db.close();

  let launched = await launchApp({ userDataDir, env: github.env });
  try {
    // The captain sends the project's pull requests through its queue.
    const { page } = launched;
    // The system browser, replaced by a recorder: nothing here opens a page.
    await launched.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await pressKey(page.getByRole("button", { name: "Settings" }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Projects" }), "Enter");
    const row = projectRow(page, "repo-meter");
    await pressKey(row.getByRole("button", { expanded: false }), "Enter");
    const choices = row.getByRole("radiogroup", { name: "Where changes go" });
    const queue = choices.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["queue-pr"] });
    await pressKey(queue, "Space");
    await expect(queue).toBeChecked();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.repos.list())).find(
          (repo) => repo.id === "repo-meter",
        ),
      )
      .toMatchObject({ delivery: "queue-pr" });
    // INF-2886: the choice reads the project's workflows; none mentions its
    // batch check, so Settings warns under Where changes go.
    const warning = row.getByRole("status").filter({
      hasText: queueSettingsWarning({ delivery: "queue-pr", queueWorkflows: [] }) ?? "",
    });
    await expect(warning).toBeVisible({ timeout: 20_000 });
    await heroShot(launched.app, page, {
      region: warning,
      anchors: [choices],
      name: "queue-workflow-warning",
    });
    // The row says what the choice needs, and its how-to opens by keys.
    const howTo = row.locator("[data-queue-how-to]");
    await expect(howTo.getByText(QUEUE_HOW_TO_WORDS.needs)).toBeVisible();
    await pressKey(howTo.getByRole("button", { name: QUEUE_HOW_TO_WORDS.label }), "Enter");
    for (const step of QUEUE_HOW_TO_WORDS.steps) await expect(howTo.getByText(step)).toBeVisible();
    await heroShot(launched.app, page, {
      region: howTo,
      anchors: [choices],
      name: "batched-pull-request",
    });
    await pressKey(howTo.getByRole("button", { name: QUEUE_HOW_TO_WORDS.guide }), "Enter");
    await expect
      .poll(() =>
        launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []),
      )
      .toEqual([QUEUE_HOW_TO_WORDS.guideLink]);
    await page.keyboard.press("Escape");

    await pressKey(
      launched.page.getByRole("button", { name: "Merge the pull request", exact: true }),
      "Enter",
    );
    // The click marks the version waiting and merges nothing.
    await expect
      .poll(() => github.statuses(headSha), { timeout: 20_000 })
      .toEqual([expect.objectContaining({ context: QUEUE_STATUS, state: "pending" })]);
    expect(github.merges()).toEqual([]);
    const saved = () => readSavedData(userDataDir, (savedDb) => new TaskStore(savedDb).get(taskId));
    await expect
      .poll(saved)
      .toMatchObject({ delivery: { prNumber: 82, mergeAuthorization: { approvedHead: headSha } } });
    // INF-2913, the captain: "only show a card if the merge went wrong and
    // needs the user's decision". The kept click waits with no card: the
    // merge card left on the click and nothing took its place.
    // The version is already marked waiting, which the click's old note came before.
    expect(await launched.page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
    await expect(shownEntry(launched.page)).toHaveCount(0);
    await windowShot(launched.page, test.info().outputPath("queue-waiting.png"));

    // The project's queue passes that version; the kept click merges it.
    github.setStatus(headSha, { context: QUEUE_STATUS, state: "success" });
    await launched.close();
    launched = await launchApp({ userDataDir, env: github.env });
    await expect
      .poll(() => github.merges(), { timeout: 30_000 })
      .toEqual([expect.objectContaining({ number: 82, sha: headSha, method: "squash" })]);
    await expect.poll(saved).toMatchObject({
      delivery: { mergeAuthorization: { status: "consumed", receipt: { head: headSha } } },
    });
    // The queue's answer is the project's first: Settings' warning has nothing left to say.
    await expect
      .poll(async () =>
        (await launched.page.evaluate(() => window.infinitary.repos.list())).find(
          (repo) => repo.id === "repo-meter",
        ),
      )
      .toMatchObject({ queueAnsweredAt: expect.any(Number) });
  } finally {
    await launched.close();
    await github.close();
  }
});
