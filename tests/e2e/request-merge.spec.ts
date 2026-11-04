import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { type MergeReview, mergeRuleWords } from "../../src/shared/mergeReview";
import { MERGE_WORDS, SKIP_RULES_MERGE_WORDS } from "../../src/shared/vocabulary";
import { NEVER_SENT_AGAIN } from "../../src/shared/writeAsk";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import {
  SKIP_RULES_CARD_TITLE,
  SKIP_RULES_FAILED_CHECK,
  SKIP_RULES_MERGE_MARKER,
  SKIP_RULES_PULL,
} from "./apiWriteCases";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { expandDock, taskKey, taskLine } from "./rails";
import { skipRules } from "./scenarios/skipRules";
import { expectNoCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * FI3-1543: one request_merge covers the task's own pull request and one
 * the task adopted. Autonomy is off. Nothing merges until the captain's key
 * on the button, and either click continues its task (INF-2490).
 */

const MERGE = MERGE_WORDS["merge-pr"];
const ADOPTED_HEAD = "4fc9140d92b3a9d25937dec0ff4f9754fdc8c8e4";
const ADOPTED_BRANCH = "release-please--branches--main";

function seedRepo(userDataDir: string, taskId: string) {
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = `fm/task-${taskId}`;
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(worktreeDir, "feature.txt"), "The crewmate's work.\n");
  git("-C", worktreeDir, "add", "feature.txt");
  git("-C", worktreeDir, "commit", "-m", "feat: the crewmate's work");
  const headSha = git("-C", worktreeDir, "rev-parse", "HEAD").trim();
  return { repoDir, worktreeDir, branch, headSha };
}

function seedReviewCard(
  db: ReturnType<typeof openDatabase>,
  taskId: string,
  review: MergeReview,
  title: string,
  body: string,
  own = false,
) {
  seedDelivery(new TaskService({ db, strict: true }), taskId, {
    mode: "direct-pr",
    // A crewmate that opened its own pull request records it on the task.
    ...(own ? { prNumber: review.number } : {}),
    mergeReviews: [review],
    // A saved review records the scripted reviewer's judgment of this exact
    // candidate; the captain's separate key remains the merge authorization.
    ciRepair: {
      failures: [],
      diagnoses: [],
      repairs: [],
      declarations: [
        {
          headSha: review.headSha,
          verdict: "ready",
          at: review.at,
          evidence: "The scripted reviewer read the arranged checks for this candidate.",
        },
      ],
    },
  });
  new CardStore(db).upsert({
    id: `card-${taskId}-merge`,
    taskId,
    author: "crewmate",
    priority: 30,
    title,
    meta: "crewmate 1",
    body,
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "merge",
        label: MERGE,
        default: true,
        effect: { kind: "request_merge", review: review.id },
      },
      { id: "not-now", label: "Not now" },
    ],
  });
}

// INF-2490 (the captain's answer to INF-2489's question 3): request_merge is
// the continuing merge whichever branch its pull request is on; only the
// completion card's merge finishes the task.
test("a request_merge of the task's own pull request merges that pull request and the task continues", async () => {
  const userDataDir = scratchDir("infinitary-request-own-");
  const taskId = "owntask";
  const repo = seedRepo(userDataDir, taskId);
  const github = await startGitHubStub();
  const change = {
    number: 55,
    title: "feat: the crewmate's work",
    body: "The crewmate's work, ready to go in.",
  };
  // GitHub answers the pull request by its number with the task's branch as
  // its head, which the click re-reads before it merges.
  github.serveNumbered({ ...change, branch: repo.branch, headSha: repo.headSha });
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-pr",
    path: repo.repoDir,
    name: "r",
    setupKind: "clone",
    origin: "https://github.com/o/r.git",
    runsOn: null,
    delivery: "direct-pr",
  });
  seedHostedOrigins(db, userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: "Ship the pull request",
    status: "idle",
    repoId: "repo-pr",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  const review: MergeReview = {
    id: "mrowned000001",
    kind: "github",
    host: "github.com",
    owner: "o",
    name: "r",
    number: change.number,
    headSha: repo.headSha,
    base: "main",
    branch: repo.branch,
    method: "squash",
    title: change.title,
    at: Date.now(),
  };
  const title = "Merge the task's pull request";
  seedReviewCard(
    db,
    taskId,
    review,
    title,
    "<p>The task opened this pull request. Merging it keeps the task open.</p>",
    true,
  );
  db.close();

  const launched = await launchApp({ userDataDir, env: github.env });
  try {
    const { page } = launched;
    await expect(shownCard(page, title)).toBeVisible();
    expect(github.merges()).toEqual([]);
    await regionShot(shownCard(page, title), test.info().outputPath("own-review.png"));
    const button = page.getByRole("button", { name: MERGE, exact: true });
    await pressKey(button, "Enter");
    await expectNoCard(page, title);
    await expect
      .poll(() => github.merges(), { timeout: 20_000 })
      .toEqual([
        {
          number: 55,
          sha: repo.headSha,
          method: "squash",
          title: change.title,
          message: change.body,
        },
      ]);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "active" });
    expect(existsSync(repo.worktreeDir)).toBe(true);
  } finally {
    await launched.close();
    await github.close();
  }
});

test("a request_merge of an adopted pull request merges that pull request and leaves the task open", async () => {
  const userDataDir = scratchDir("infinitary-request-adopted-");
  const taskId = "adoptask";
  const repo = seedRepo(userDataDir, taskId);
  const github = await startGitHubStub();
  github.serveNumbered({
    number: 151,
    branch: ADOPTED_BRANCH,
    title: "feat: start the 0.1.20 upload",
    body: "Release notes only.",
    headSha: ADOPTED_HEAD,
  });
  github.setChecks([]);
  github.priorPullRequestWorkflows(true);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-pr",
    path: repo.repoDir,
    name: "r",
    setupKind: "clone",
    origin: "https://github.com/o/r.git",
    runsOn: null,
    delivery: "direct-pr",
  });
  seedHostedOrigins(db, userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: "Watch the release",
    status: "idle",
    repoId: "repo-pr",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  const review: MergeReview = {
    id: "mradopted0001",
    kind: "github",
    host: "github.com",
    owner: "o",
    name: "r",
    number: 151,
    headSha: ADOPTED_HEAD,
    base: "main",
    branch: ADOPTED_BRANCH,
    method: "squash",
    title: "feat: start the 0.1.20 upload",
    absentChecks: {
      headSha: ADOPTED_HEAD,
      evidence: "The workflow excludes the three release files, and this head has no check run.",
      localGate: "pnpm typecheck && pnpm check && pnpm lint:adherence passed at this version.",
    },
    at: Date.now(),
  };
  const title = "Merge the release pull request";
  seedReviewCard(
    db,
    taskId,
    review,
    title,
    "<p>Someone else opened pull request 151. Merging it starts the upload and leaves this task open.</p>",
  );
  db.close();

  const launched = await launchApp({ userDataDir, env: github.env });
  try {
    const { page } = launched;
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    expect(github.merges()).toEqual([]);
    expect(github.requests().some((request) => request.startsWith("PUT "))).toBe(false);
    await regionShot(card, test.info().outputPath("adopted-review.png"));
    await heroShot(launched.app, page, {
      region: card,
      anchors: [page.getByRole("button", { name: MERGE, exact: true })],
      name: "merge-a-pull-request-you-did-not-open",
      dir: test.info().outputPath("hero"),
    });
    const button = page.getByRole("button", { name: MERGE, exact: true });
    await pressKey(button, "Enter");
    await expectNoCard(page, title);
    await expect
      .poll(() => github.merges(), { timeout: 20_000 })
      .toEqual([
        {
          number: 151,
          sha: ADOPTED_HEAD,
          method: "squash",
          title: "feat: start the 0.1.20 upload",
          message: "",
        },
      ]);
    expect(github.requests().some((request) => request.startsWith("PATCH "))).toBe(false);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "active" });
    expect(existsSync(repo.worktreeDir)).toBe(true);
    await expandDock(page, "activity");
    await regionShot(
      page.locator("[data-side-panel='activity']"),
      test.info().outputPath("adopted-task-stays.png"),
    );
  } finally {
    await launched.close();
    await github.close();
  }
});

test("a request_merge of an adopted pull request waits while GitHub works out whether it can merge, then merges it", async () => {
  // INF-457: the captain's two clicks on PR #94 were refused because GitHub,
  // just after main moved, answered mergeable null (state unknown) to the
  // click's one read, and clean to reads seconds later at the same head.
  const userDataDir = scratchDir("infinitary-request-undecided-");
  const taskId = "undecided";
  const repo = seedRepo(userDataDir, taskId);
  const github = await startGitHubStub();
  github.serveNumbered({
    number: 151,
    branch: ADOPTED_BRANCH,
    title: "feat: start the 0.1.20 upload",
    headSha: ADOPTED_HEAD,
    undecidedReads: 2,
  });
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-pr",
    path: repo.repoDir,
    name: "r",
    setupKind: "clone",
    origin: "https://github.com/o/r.git",
    runsOn: null,
    delivery: "direct-pr",
  });
  seedHostedOrigins(db, userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: "Watch the release",
    status: "idle",
    repoId: "repo-pr",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  const review: MergeReview = {
    id: "mrundecided01",
    kind: "github",
    host: "github.com",
    owner: "o",
    name: "r",
    number: 151,
    headSha: ADOPTED_HEAD,
    base: "main",
    branch: ADOPTED_BRANCH,
    method: "squash",
    title: "feat: start the 0.1.20 upload",
    at: Date.now(),
  };
  const title = "Merge the release pull request";
  seedReviewCard(
    db,
    taskId,
    review,
    title,
    "<p>Someone else opened pull request 151. Merging it starts the upload and leaves this task open.</p>",
  );
  db.close();

  const launched = await launchApp({ userDataDir, env: github.env });
  try {
    const { page } = launched;
    await expect(shownCard(page, title)).toBeVisible();
    const read = "GET /repos/o/r/pulls/151";
    expect(github.requests().filter((request) => request === read)).toEqual([]);
    await pressKey(page.getByRole("button", { name: MERGE, exact: true }), "Enter");
    await expectNoCard(page, title);
    await expect
      .poll(() => github.merges(), { timeout: 30_000 })
      .toEqual([
        {
          number: 151,
          sha: ADOPTED_HEAD,
          method: "squash",
          title: "feat: start the 0.1.20 upload",
          message: "",
        },
      ]);
    // Two undecided answers, then the clean one, and only then the merge.
    const requests = github.requests();
    const merge = requests.indexOf("PUT /repos/o/r/pulls/151/merge");
    expect(requests.slice(0, merge).filter((request) => request === read)).toHaveLength(3);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "active" });
    // The task notes the merge where the captain reads the activity.
    await expandDock(page, "activity");
    await expect(taskLine(page, await taskKey(page, "Watch the release"), "note")).toBeVisible();
    await regionShot(
      page.locator("[data-side-panel='activity']"),
      test.info().outputPath("undecided-merged.png"),
    );
    await test.info().attach("undecided-merge", {
      body: requests.join("\n"),
      contentType: "text/plain",
    });
  } finally {
    await launched.close();
    await github.close();
  }
});

test("a merge that skips the branch rules is prepared by its crewmate, named on the card, and sent once on the captain's key", async () => {
  const userDataDir = scratchDir("infinitary-request-skip-");
  // A project on GitHub whose release pull request waits on a code owner's
  // review and has one failed check; the captain's account may skip both.
  const repoDir = join(userDataDir, "shipyard");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  mkdirSync(repoDir);
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  const github = await startGitHubStub();
  github.serveNumbered({ ...SKIP_RULES_PULL, mergeableState: "blocked" });
  github.setChecks([{ name: SKIP_RULES_FAILED_CHECK, status: "completed", conclusion: "failure" }]);
  const rules = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } },
    { type: "required_status_checks" },
  ];
  github.setRulesets([{ id: 17860669, name: "main", bypass: "always", rules }]);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-shipyard",
    path: repoDir,
    name: "shipyard",
    setupKind: "clone",
    origin: "https://github.com/octo/shipyard.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();

  const launched = await launchApp({
    scenarios: [skipRules],
    withMockProvider: true,
    userDataDir,
    env: github.env,
  });
  try {
    const { page } = launched;
    const title = `shipyard ${SKIP_RULES_MERGE_MARKER}`;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    const card = shownCard(page, SKIP_RULES_CARD_TITLE);
    await expect(card).toBeVisible({ timeout: 45_000 });
    // The host drew what the click does: every rule that can hold the merge
    // and the failed check, never the rules that only guard the branch.
    const strip = cardBody(page, SKIP_RULES_CARD_TITLE).locator('[data-inf-call="merge"]');
    const named = rules.flatMap((rule) => mergeRuleWords(rule.type) ?? []);
    await expect(strip.locator('[data-inf-skip="rule"]')).toHaveCount(named.length);
    for (const words of named) await expect(strip).toContainText(words);
    await expect(strip.locator('[data-inf-skip="check"]')).toHaveCount(1);
    await expect(strip.locator('[data-inf-skip="check"]')).toContainText(SKIP_RULES_FAILED_CHECK);
    // Nothing is sent before the click: no merge of either kind.
    expect(github.asyncMerges()).toEqual([]);
    expect(github.requests().some((request) => request.startsWith("PUT "))).toBe(false);
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence) {
      // A crewmate's evidence run, and the change's hero pair (docs/testing.md "A hero picture"),
      // in a window tall enough to show the whole strip.
      await resizeWindow(launched.app, page, { width: 1100, height: 860 });
      await regionShot(card, join(evidence, "skip-rules-card.png"));
      await heroShot(launched.app, page, {
        region: card,
        anchors: [page.getByRole("button", { name: SKIP_RULES_MERGE_WORDS, exact: true })],
        name: "merge-past-branch-rules",
      });
    }
    await pressKey(
      page.getByRole("button", { name: SKIP_RULES_MERGE_WORDS, exact: true }),
      "Enter",
    );
    await expectNoCard(page, SKIP_RULES_CARD_TITLE);
    // Once after it: the asynchronous merge that skips the rules, squash, at
    // the version the crewmate read, and never the ordinary merge.
    const once = [
      {
        number: SKIP_RULES_PULL.number,
        sha: SKIP_RULES_PULL.headSha,
        method: "squash",
        action: "direct_merge",
        bypass: true,
        title: SKIP_RULES_PULL.title,
        message: "",
      },
    ];
    await expect.poll(() => github.asyncMerges(), { timeout: 20_000 }).toEqual(once);
    expect(github.merges()).toEqual([]);
    // The crewmate hears it once and asks again with the same review: the
    // revised card is refused and nothing is sent a second time.
    let id = "";
    await expect
      .poll(
        async () => {
          const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
            (row) => row.title === title,
          );
          id = task?.id ?? "";
          const detail = id
            ? await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id)
            : undefined;
          return detail?.outcome ?? "";
        },
        { timeout: 45_000 },
      )
      .toMatch(new RegExp(`Asking again: Card refused[^\\n]*${NEVER_SENT_AGAIN}`));
    expect(github.asyncMerges()).toEqual(once);
    // The adopted pull request merged; the task stays open with its working copy.
    await expect
      .poll(() => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id))
      .toMatchObject({ status: "active" });
    const transcript = `${github.requests().join("\n")}\n\nAsync merges:\n${JSON.stringify(github.asyncMerges(), null, 2)}`;
    await test.info().attach("skip-rules-merge", { body: transcript, contentType: "text/plain" });
    if (evidence) writeFileSync(join(evidence, "skip-rules-merge.txt"), transcript);
  } finally {
    await launched.close();
    await github.close();
  }
});
