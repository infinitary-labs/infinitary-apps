import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { QUEUE_STATUS } from "../../src/core/forge/forge";
import { QUEUE_PLAN_ASKED_OPENING } from "../../src/core/orchestrator/noticeWakes";
import { QUEUE_SETUP_WORDS } from "../../src/core/orchestrator/queueChoice";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  QUEUE_HOW_TO_WORDS,
  queueWaitingWords,
} from "../../src/renderer/src/settings/projectsWords";
import { queueSettingsWarning } from "../../src/shared/repos";
import { PROJECT_DELIVERY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { heroShot, windowShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { projectRow } from "./projects";
import { readSavedData } from "./savedData";
import { cardSurface, showCard, shownCard, shownEntry } from "./stack";
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
 * first answers. The project chose the queue on an earlier version, before
 * INF-2885's direction B held such a choice, and its read found no workflow;
 * the merge click then marks the version and merges nothing; once the
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
  // A project that chose batched pull requests on an earlier version, whose
  // read then found no workflow that mentions its batch check (INF-2885's
  // direction B now holds such a choice; see the next test).
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor, queue_workflows_json) VALUES (?, ?, ?, ?, 'clone', ?, 'queue-pr', 0, 'quick', '[]')",
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
    // The project sends its pull requests through its queue.
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
    await expect(queue).toBeChecked();
    // INF-2886: the last read of the project's workflows found none that
    // mentions its batch check, so Settings warns under Where changes go.
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

/**
 * INF-2885, the captain's direction B, "Wake at the choice; switch on only
 * once the queue merges", and their words: "we should show a card that tells
 * user their repo is not set up to use that option yet, and give them the
 * option to ask first mate to plan it".
 *
 * A disposable GitHub serves a project with no workflow that mentions its
 * batch check, and the pull request a crewmate finished. The captain chooses
 * batched pull requests by keys: the project keeps pull requests, Settings
 * says the choice waits, and the app's card says the project is not set up
 * yet. Its Ask the first mate to plan it tells the first mate. The queue
 * workflow then reaches the project's default branch, and the next merge in
 * the project, a plain pull request, switches the project to batched pull
 * requests by itself. Requires desktop Electron and local git; no real
 * sign-in or shared pull request.
 */
test("choosing batched pull requests with no queue workflow waits, asks on a card, then switches on once one merges", async () => {
  const userDataDir = scratchDir("infinitary-queue-choice-");
  const taskId = "queueplanned";
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = `fm/task-${taskId}`;
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  const workflow = `name: Batch\non:\n  status:\n  workflow_dispatch:\njobs:\n  batch:\n    if: github.event.context == '${QUEUE_STATUS}'\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;
  mkdirSync(join(worktreeDir, ".github", "workflows"), { recursive: true });
  // e2e-fixture: input -- Author the real queue workflow this journey merges.
  writeFileSync(join(worktreeDir, ".github", "workflows", "batch.yml"), workflow);
  git("-C", worktreeDir, "add", ".github/workflows/batch.yml");
  git("-C", worktreeDir, "commit", "-m", "chore(ci): add the batch check");
  const headSha = git("-C", worktreeDir, "rev-parse", "HEAD").trim();

  const github = await startGitHubStub();
  github.servePull({
    number: 91,
    title: "chore(ci): add the batch check",
    body: "The batch check answers the project's queue.",
  });
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
    title: "Add the batch check",
    status: "idle",
    repoId: "repo-meter",
    repoDir,
    worktreeDir,
    branch,
  });
  new CardStore(db).upsert({
    id: `card-${taskId}-1`,
    taskId,
    author: "crewmate",
    priority: 30,
    title: "The batch check is added",
    meta: "crewmate 1",
    body: "<p>The workflow answers the batch check.</p><p>It adds one file.</p>",
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

  const launched = await launchApp({ userDataDir, env: github.env, withMockProvider: true });
  try {
    const { page } = launched;
    const meter = async () =>
      (await page.evaluate(() => window.infinitary.repos.list())).find(
        (repo) => repo.id === "repo-meter",
      );
    await pressKey(page.getByRole("button", { name: "Settings" }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Projects" }), "Enter");
    const row = projectRow(page, "repo-meter");
    await pressKey(row.getByRole("button", { expanded: false }), "Enter");
    const choices = row.getByRole("radiogroup", { name: "Where changes go" });
    await pressKey(
      choices.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["queue-pr"] }),
      "Space",
    );
    // The choice waits: the project keeps pull requests, and Settings says why.
    const waiting = row.getByRole("status").filter({ hasText: queueWaitingWords("direct-pr") });
    await expect(waiting).toBeVisible({ timeout: 20_000 });
    await expect(
      choices.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["direct-pr"], exact: true }),
    ).toBeChecked();
    await expect
      .poll(meter)
      .toMatchObject({ delivery: "direct-pr", queuePendingAt: expect.any(Number) });
    await page.keyboard.press("Escape");

    // The app's card says the project is not set up yet and offers the plan.
    const title = QUEUE_SETUP_WORDS.title("meter");
    await showCard(page, title);
    await expect(cardBody(page, title).locator("body")).toContainText(
      QUEUE_SETUP_WORDS.missing("meter"),
    );
    await heroShot(launched.app, page, {
      region: cardSurface(page),
      name: "queue-not-set-up",
    });
    await pressKey(
      page.getByRole("button", { name: QUEUE_SETUP_WORDS.plan, exact: true }),
      "Enter",
    );
    await expect(shownCard(page, title)).toHaveCount(0);
    // The first mate hears the ask, naming the project.
    const told = () =>
      (launched.mockProvider?.requestBodies() ?? []).filter(
        (body) => body.includes(QUEUE_PLAN_ASKED_OPENING) && body.includes("repo_id repo-meter"),
      ).length;
    await expect.poll(told, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await meter()).toMatchObject({ delivery: "direct-pr" });

    // The planned workflow merges as a plain pull request; once it is on the
    // default branch, the merge's read switches the project on.
    github.serveWorkflows([
      { path: ".github/workflows/batch.yml", state: "active", text: workflow },
    ]);
    await showCard(page, "The batch check is added");
    await pressKey(
      page.getByRole("button", { name: "Merge the pull request", exact: true }),
      "Enter",
    );
    await expect
      .poll(() => github.merges(), { timeout: 30_000 })
      .toEqual([expect.objectContaining({ number: 91, sha: headSha })]);
    expect(github.statuses(headSha)).toEqual([]);
    await expect.poll(meter, { timeout: 30_000 }).toMatchObject({
      delivery: "queue-pr",
      queueWorkflows: [{ path: ".github/workflows/batch.yml", active: true }],
    });
    expect((await meter())?.queuePendingAt).toBeUndefined();
  } finally {
    await launched.close();
    await github.close();
  }
});
