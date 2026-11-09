import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { QUEUE_STATUS } from "../../src/core/forge/forge";
import { CHECK_WATCH_FAST_MS } from "../../src/core/orchestrator/checkWatch";
import {
  QUEUE_PAUSED_OPENING,
  QUEUE_PLAN_ASKED_OPENING,
} from "../../src/core/orchestrator/noticeWakes";
import { QUEUE_SETUP_WORDS } from "../../src/core/orchestrator/queueChoice";
import { GITHUB_QUEUE_PART, shippedFiles } from "../../src/core/queue/shipped";
import { pauseIssue, pauseWrites, verdict, WAITING } from "../../src/core/queue/shipped/rules.mjs";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  QUEUE_HOW_TO_WORDS,
  QUEUE_PAUSE_WORDS,
  QUEUE_SHIPPED_WORDS,
  queueWaitingWords,
} from "../../src/renderer/src/settings/projectsWords";
import { queueSettingsWarning } from "../../src/shared/repos";
import { PROJECT_DELIVERY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp, SHORT_TICK } from "./launch";
import { heroShot, windowShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { projectRow } from "./projects";
import { readSavedData } from "./savedData";
import { cardSurface, showCard, shownCard, shownEntry } from "./stack";
import { focusOn, pressKey, typeInto } from "./windowKeys";

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
        effect: { kind: "merge", after: "close" },
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
        effect: { kind: "merge", after: "close" },
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

/**
 * The shipped queue, every teammate's view and its quiet pause (the
 * captain's plan answers shipped-queue, claim-issue and quiet, with their
 * words "make the fix forward behavior the default for everyone using this
 * mode"; the plan's done criterion puts a second teammate's change in the
 * batch).
 *
 * A disposable GitHub serves a project whose default branch runs the queue
 * Infinitary ships, read from its one source, to a teammate whose Infinitary
 * still sends the project's changes as pull requests, and the pull request a
 * crewmate finished there. The app reads the stamp at start and batches the
 * project, fixed in Settings. The captain's merge click marks the version
 * waiting. The queue then pauses the batch it formed from that change and a
 * teammate's change it never saw, behind one issue: the app's own reading of
 * the change's checks finds the pause, keeps it, tells the first mate once
 * and puts up no card. A teammate takes the issue, and Settings names them.
 * The captain resumes by keys with a reason; the queue starts with that
 * answer, closes the issue, and Settings shows the pause ended. Requires
 * desktop Electron and local git; no real sign-in or shared pull request.
 */
/** The shipped queue's one source, which a project's files are generated from. */
const SHIPPED_SOURCE_DIR = fileURLToPath(new URL("../../src/core/queue/shipped/", import.meta.url));

test("a project running the shipped queue is batched for every teammate, and its paused batch with a teammate's change resumes from Settings by keys", async () => {
  // The app first reads the change again when its check watch does, one
  // watch interval after the merge click, so the journey outlasts it.
  test.setTimeout(3 * 60_000);
  const userDataDir = scratchDir("infinitary-queue-shipped-");
  const taskId = "shippedpause";
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = `fm/task-${taskId}`;
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project file this journey batches.
  writeFileSync(join(worktreeDir, "meter.txt"), "The meter reads on time.\n");
  git("-C", worktreeDir, "add", "meter.txt");
  git("-C", worktreeDir, "commit", "-m", "fix: read the meter on time");
  const headSha = git("-C", worktreeDir, "rev-parse", "HEAD").trim();
  const queueFile = shippedFiles(SHIPPED_SOURCE_DIR, GITHUB_QUEUE_PART).find(
    (file) => file.path === GITHUB_QUEUE_PART.queueFile,
  );

  const github = await startGitHubStub();
  github.serveWorkflows([
    { path: GITHUB_QUEUE_PART.queueFile, state: "active", text: queueFile?.text ?? "" },
  ]);
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
  const cardId = `card-${taskId}-1`;
  const offerId = "offer-shipped";
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
    lifecycleId: "lifecycle-shipped",
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
        effect: { kind: "merge", after: "close" },
      },
    ],
  });
  db.close();

  const launched = await launchApp({
    userDataDir,
    env: { ...github.env, ...SHORT_TICK },
    withMockProvider: true,
  });
  try {
    const { page } = launched;
    const meter = async () =>
      (await page.evaluate(() => window.infinitary.repos.list())).find(
        (repo) => repo.id === "repo-meter",
      );
    // The app read the project's queue at start: it is batched here too.
    await expect.poll(meter, { timeout: 20_000 }).toMatchObject({ delivery: "queue-pr" });

    // The captain's merge click marks the version waiting for the batch.
    await showCard(page, "The meter reads on time");
    await pressKey(
      page.getByRole("button", { name: "Merge the pull request", exact: true }),
      "Enter",
    );
    await expect
      .poll(() => github.statuses(headSha), { timeout: 20_000 })
      .toEqual([expect.objectContaining({ context: QUEUE_STATUS, state: "pending" })]);

    // The queue batches it with a teammate's change, #14, and the batch
    // fails: the queue's own verdict names the pause, its issue and the
    // paused status it writes on each change.
    const runUrl = "https://github.com/o/meter/actions/runs/4410";
    const members = [
      { number: 82, head: headSha },
      { number: 14, head: "e".repeat(40) },
    ];
    const { pause } = verdict({
      run: 4410,
      runUrl,
      result: "failure",
      tree: "",
      members,
      current: new Map(
        members.map((member) => [
          member.number,
          {
            head: member.head,
            queue: {
              kind: "in-batch",
              run: 4410,
              state: "pending",
              description: "",
              url: runUrl,
              since: "",
            },
          },
        ]),
      ),
      failed: [{ name: "Batch checks / unit", url: runUrl }],
    });
    if (!pause) throw new Error("A red batch pauses.");
    const issue = pauseIssue(pause, runUrl);
    github.servePauseIssue({ number: 88, body: issue.body });
    const [paused] = pauseWrites(pause, "https://github.com/o/meter/issues/88");
    github.setStatus(headSha, {
      context: QUEUE_STATUS,
      state: "pending",
      description: paused?.description ?? "",
    });

    // The app's own reading of the change finds the pause and keeps it:
    // the check watch reads it at its first interval after the click.
    await expect.poll(meter, { timeout: CHECK_WATCH_FAST_MS * 2 }).toMatchObject({
      queuePause: { run: 4410, changes: [82, 14], url: "https://github.com/o/meter/issues/88" },
    });
    // The first mate hears it once, and no card goes up for it. Each turn
    // sends the whole conversation, so the most the wake shows up in any
    // one request is how many times the first mate was told.
    // The wake's opening comes from its owner, and this project's one pause
    // is the only queue-paused wake the app sends.
    const told = () =>
      Math.max(
        0,
        ...(launched.mockProvider?.requestBodies() ?? []).map(
          (body) => body.split(QUEUE_PAUSED_OPENING).length - 1,
        ),
      );
    await expect.poll(told, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual([]);

    await pressKey(page.getByRole("button", { name: "Settings" }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Projects" }), "Enter");
    const row = projectRow(page, "repo-meter");
    await pressKey(row.getByRole("button", { expanded: false }), "Enter");
    const choices = row.getByRole("radiogroup", { name: "Where changes go" });
    const queue = choices.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["queue-pr"] });
    await expect(queue).toBeChecked();
    await expect(queue).toBeDisabled();
    await expect(row.getByText(QUEUE_SHIPPED_WORDS.set(GITHUB_QUEUE_PART.version))).toBeVisible();
    await expect(row.locator("[data-queue-how-to]")).toHaveCount(0);
    const panel = row.getByRole("region", { name: QUEUE_PAUSE_WORDS.title });
    await expect(panel.getByText(QUEUE_PAUSE_WORDS.unclaimed)).toBeVisible();

    // The teammate takes the issue: every pass reads it, and Settings names them.
    github.servePauseIssue({ number: 88, body: issue.body, assignees: ["rosa"] });
    await expect(panel.getByText(QUEUE_PAUSE_WORDS.claimed("rosa"))).toBeVisible({
      timeout: 30_000,
    });

    // Resume needs a reason, and goes out once with it.
    const resume = panel.getByRole("button", { name: QUEUE_PAUSE_WORDS.resume });
    await pressKey(resume, "Enter");
    await expect(panel.getByRole("alert")).toHaveText(QUEUE_PAUSE_WORDS.needsReason);
    const reason = "The failed test is flaky and its owner has a task";
    const field = panel.getByRole("textbox", { name: QUEUE_PAUSE_WORDS.reason });
    await focusOn(field);
    await typeInto(field, reason);
    await pressKey(resume, "Enter");
    await expect(panel.getByText(QUEUE_PAUSE_WORDS.sent)).toBeVisible();
    expect(github.queueStarts()).toEqual([{ ref: "main", inputs: { action: "resume", reason } }]);

    // The queue answers: the issue closes and the change waits again. The
    // next pass ends the pause here, though the change is no longer paused.
    github.servePauseIssue(null);
    github.setStatus(headSha, { context: QUEUE_STATUS, state: "pending", description: WAITING });
    await expect(panel).toHaveCount(0, { timeout: 30_000 });
    expect((await meter())?.queuePause).toBeUndefined();
    expect(told()).toBe(1);
  } finally {
    await launched.close();
    await github.close();
  }
});
