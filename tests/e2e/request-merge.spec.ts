import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { presentationCommitMessage, presentationMarkdownText } from "../../src/core/forge";
import { QUEUE_STATUS, QUEUE_WAITING_WORDS } from "../../src/core/forge/forge";
import { GITHUB_QUEUE_PART, GITLAB_QUEUE_PART, shippedFiles } from "../../src/core/queue/shipped";
import { passed } from "../../src/core/queue/shipped/rules.mjs";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import { type MergeReview, mergeRuleWords } from "../../src/shared/mergeReview";
import { MERGE_WORDS, SKIP_RULES_MERGE_WORDS } from "../../src/shared/vocabulary";
import { NEVER_SENT_AGAIN } from "../../src/shared/writeAsk";
import { BUNDLED_NAMING } from "../helpers/namingRunbook";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import {
  SKIP_RULES_CARD_TITLE,
  SKIP_RULES_FAILED_CHECK,
  SKIP_RULES_MERGE_MARKER,
  SKIP_RULES_PULL,
} from "./apiWriteCases";
import { startDemo } from "./demo";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { GITLAB_STUB_PROJECT, seedGitLabSignIn, startGitLabStub } from "./gitlabStub";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { mergePassedFixture } from "./queueMergeDriver";
import { expandDock, taskKey, taskLine } from "./rails";
import { readSavedData } from "./savedData";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import {
  CONTRIBUTOR_PULL,
  CONTRIBUTOR_REVIEW_MARKER,
  CONTRIBUTOR_REVIEW_TITLE,
  contributorReview,
} from "./scenarios/contributorReview";
import {
  CONTRIBUTOR_STORY_MARKER,
  CONTRIBUTOR_STORY_TITLE,
  contributorStory,
} from "./scenarios/contributorStory";
import { SKIP_RULES_ASKING_AGAIN, skipRules } from "./scenarios/skipRules";
import { expectNoCard, showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * FI3-1543: one merge request covers the task's own pull request and one
 * the task adopted. Autonomy is off. Nothing merges until the captain's key
 * on the button, and either click continues its task (INF-2490). INF-2744
 * asks every merge on the one merge card, whose `after: continue` says the
 * task goes on, and a task may have several merge cards up at once ("a
 * request is just like calling a tool").
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
  reviews: MergeReview[] = [review],
) {
  seedDelivery(new TaskService({ db, strict: true }), taskId, {
    mode: "direct-pr",
    // A crewmate that opened its own pull request records it on the task.
    ...(own ? { prNumber: review.number } : {}),
    mergeReviews: reviews,
    // A saved review records the scripted reviewer's judgment of this exact
    // candidate; the captain's separate key remains the merge authorization.
    ciRepair: {
      failures: [],
      diagnoses: [],
      repairs: [],
      declarations: reviews.map((each) => ({
        headSha: each.headSha,
        verdict: "ready" as const,
        at: each.at,
        evidence: "The scripted reviewer read the arranged checks for this candidate.",
      })),
    },
  });
  new CardStore(db).upsert({
    id: `card-${taskId}-merge-${review.number}`,
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
        effect: { kind: "merge", review: review.id, after: "continue" },
      },
      { id: "not-now", label: "Not now" },
    ],
  });
}

// INF-2490 (the captain's answer to INF-2489's question 3): a continuing
// merge whichever branch its pull request is on; INF-2744 makes it a merge
// card whose `after: continue` keeps the task open.
test("a merge card that continues the task merges its own pull request and the task continues (INF-2744)", async () => {
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

test("a merge card for an adopted pull request merges that pull request and leaves the task open (INF-2744)", async () => {
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

test("a merge card for an adopted pull request waits while GitHub works out whether it can merge, then merges it (INF-2744)", async () => {
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

// INF-2744, the captain's words: "a single task can request many merges - a
// request is just like calling a tool". One task holds two merge cards at
// once, its own pull request's and an adopted one's; each click merges its
// own pull request alone, and the task continues after both.
test("one task holds a merge card for each of two pull requests, and each click merges its own (INF-2744)", async () => {
  const userDataDir = scratchDir("infinitary-request-two-");
  const taskId = "twotask";
  const repo = seedRepo(userDataDir, taskId);
  const github = await startGitHubStub();
  const own = { number: 55, title: "feat: the crewmate's work", body: "The crewmate's work." };
  github.serveNumbered({ ...own, branch: repo.branch, headSha: repo.headSha });
  github.serveNumbered({
    number: 151,
    branch: ADOPTED_BRANCH,
    title: "feat: start the 0.1.20 upload",
    headSha: ADOPTED_HEAD,
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
    title: "Ship the work and its release",
    status: "idle",
    repoId: "repo-pr",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  const at = Date.now();
  const ownReview: MergeReview = {
    id: "mrtwoown00001",
    kind: "github",
    host: "github.com",
    owner: "o",
    name: "r",
    number: own.number,
    headSha: repo.headSha,
    base: "main",
    branch: repo.branch,
    method: "squash",
    title: own.title,
    at,
  };
  const adoptedReview: MergeReview = {
    ...ownReview,
    id: "mrtwoadopted1",
    number: 151,
    headSha: ADOPTED_HEAD,
    branch: ADOPTED_BRANCH,
    title: "feat: start the 0.1.20 upload",
  };
  const reviews = [ownReview, adoptedReview];
  const ownTitle = "Merge the task's pull request";
  const adoptedTitle = "Merge the release pull request";
  seedReviewCard(db, taskId, ownReview, ownTitle, "<p>The task's own work.</p>", true, reviews);
  seedReviewCard(
    db,
    taskId,
    adoptedReview,
    adoptedTitle,
    "<p>Someone else opened pull request 151.</p>",
    false,
    reviews,
  );
  db.close();

  const launched = await launchApp({ userDataDir, env: github.env });
  try {
    const { page } = launched;
    // Both merge cards are up for the one task.
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.cards.list()))
          .filter((card) => card.taskId === taskId)
          .map((card) => card.title)
          .sort(),
      )
      .toEqual([adoptedTitle, ownTitle].sort());
    expect(github.merges()).toEqual([]);
    for (const [title, number] of [
      [ownTitle, own.number],
      [adoptedTitle, 151],
    ] as const) {
      await showCard(page, title);
      const card = shownCard(page, title);
      await pressKey(card.getByRole("button", { name: MERGE, exact: true }), "Enter");
      await expectNoCard(page, title);
      await expect
        .poll(() => github.merges().map((merge) => merge.number), { timeout: 20_000 })
        .toContain(number);
    }
    expect(github.merges().map((merge) => merge.number)).toEqual([own.number, 151]);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "active" });
    expect(existsSync(repo.worktreeDir)).toBe(true);
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
      .toMatch(new RegExp(`${SKIP_RULES_ASKING_AGAIN} Card refused[^\\n]*${NEVER_SENT_AGAIN}`));
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

// Accepted contributor plan A. Real git owns the contribution; a local host
// serves the fork's source and successful checks. A scripted crewmate reads
// its code before check_change and emits a merge card. Enter queues only
// that head, and its kept approval merges after the queue passes. No real
// account, contributed package scripts or shared host changes are involved.
test("a crewmate reads a fork and the captain's keyboard merge queues its reviewed version", async () => {
  const userDataDir = scratchDir("infinitary-contributor-review-");
  const repo = seedRepo(userDataDir, "forkfixture");
  execFileSync("git", ["-C", repo.repoDir, "branch", "contribution", repo.headSha]);
  const github = await startGitHubStub();
  github.serveNumbered({
    number: CONTRIBUTOR_PULL,
    branch: "contribution",
    title: "fix: read the meter on time",
    body: "The contributor's explanation stays here.",
    headSha: repo.headSha,
    headRepo: "contributor/r",
    headRepoId: 912,
  });
  github.setChecks([{ name: "build", status: "completed", conclusion: "success" }]);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-forks",
    path: repo.repoDir,
    name: "r",
    setupKind: "clone",
    origin: "https://github.com/o/r.git",
    runsOn: null,
    delivery: "queue-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const demo = await startDemo({
    userDataDir,
    withMockProvider: true,
    scenarios: [contributorReview],
    env: github.env,
    size: { width: 1280, height: 800 },
  });
  let launched = demo.launched;
  try {
    const { page } = launched;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} r ${CONTRIBUTOR_REVIEW_MARKER}`);
    await input.press("Enter");
    const card = shownCard(page, CONTRIBUTOR_REVIEW_TITLE);
    await expect(card).toBeVisible({ timeout: 45_000 });
    expect(github.merges()).toEqual([]);
    expect(github.statuses(repo.headSha)).toEqual([]);
    await regionShot(card, test.info().outputPath("contributor-review.png"));
    await demo.record("Queue the reviewed contribution", "window", async () => {
      await demo.step(async () => {
        await pressKey(page.getByRole("button", { name: MERGE, exact: true }), "Enter");
        await expect
          .poll(() => github.statuses(repo.headSha))
          .toContainEqual(expect.objectContaining({ context: QUEUE_STATUS, state: "pending" }));
        await expectNoCard(page, CONTRIBUTOR_REVIEW_TITLE);
      });
    });
    expect(github.merges()).toEqual([]);
    await demo.finish({
      dir: test.info().outputPath("demo"),
      name: "reviewed-fork-queues",
      format: "mp4",
    });
    github.setStatus(repo.headSha, { context: QUEUE_STATUS, state: "success" });
    launched = await launchApp({
      userDataDir,
      withMockProvider: true,
      scenarios: [contributorReview],
      env: github.env,
    });
    await expect
      .poll(() => github.merges(), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({ number: CONTRIBUTOR_PULL, sha: repo.headSha, method: "squash" }),
      ]);
    const requests = github.requests();
    expect(
      requests.some((request) => request.startsWith(`GET /repos/o/r/pulls/${CONTRIBUTOR_PULL}`)),
    ).toBe(true);
    expect(requests.some((request) => request.startsWith("PATCH "))).toBe(false);
    await test.info().attach("fork-review-queue-merge", {
      body: JSON.stringify(
        { requests, merges: github.merges(), statuses: github.statuses(repo.headSha) },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await launched.close();
    await github.close();
  }
});

// Careful proof for accepted piece A and the captain's title choice. Each
// case runs the actual app, git, publisher, forge and saved approval against
// one private HTTP stand-in. Real host permissions/events remain INF-3569's
// declared gap. The result is the retained comment, original request text,
// queued head and squash payload, not a claim about a real model's judgment.
for (const kind of ["github", "gitlab"] as const) {
  for (const owned of [false, true]) {
    test(`${kind}: the app publishes a fork story and keeps its title through the queued merge${owned ? " on the current shipped queue" : ""}`, async () => {
      const userDataDir = scratchDir("infinitary-contributor-story-");
      const repoDir = join(userDataDir, "meterlab");
      const bare = join(userDataDir, "host.git");
      const git = (...args: string[]) =>
        execFileSync("git", args, { stdio: "pipe" }).toString().trim();
      const host = kind === "github" ? "github.com" : "gitlab.com";
      const fullName = kind === "github" ? "o/r" : GITLAB_STUB_PROJECT;
      const origin = `https://${host}/${fullName}.git`;
      git("init", "--initial-branch=main", repoDir);
      git("-C", repoDir, "config", "user.name", "Test");
      git("-C", repoDir, "config", "user.email", "test@localhost");
      git("-C", repoDir, "config", "commit.gpgsign", "false");
      git("-C", repoDir, "config", "core.hooksPath", "/dev/null");
      git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: seed the meter");
      git("-C", repoDir, "switch", "-c", "contribution");
      // e2e-fixture: input -- The contributor's actual commit is read by the scripted reviewer.
      writeFileSync(join(repoDir, "meter.txt"), "The meter reads on time.\n");
      git("-C", repoDir, "add", "meter.txt");
      git("-C", repoDir, "commit", "-m", "fix: keep the meter reading current");
      const head = git("-C", repoDir, "rev-parse", "HEAD");
      git("-C", repoDir, "switch", "main");
      git("init", "--bare", "--initial-branch=main", bare);
      git("-C", repoDir, "remote", "add", "origin", origin);
      git("-C", repoDir, "config", `url.${bare}.insteadOf`, origin);
      git("-C", repoDir, "push", "origin", "main", "contribution");
      git("-C", repoDir, "fetch", "origin");
      const github = kind === "github" ? await startGitHubStub() : undefined;
      const gitlab = kind === "gitlab" ? await startGitLabStub(host) : undefined;
      const stub = github ?? gitlab;
      if (!stub) throw new Error("The proof needs its isolated host");
      stub.headOf((branch) => git("-C", bare, "rev-parse", `refs/heads/${branch}`));
      const original = {
        title: "Fix typo",
        description: "The contributor's original explanation stays here.",
      };
      let number = CONTRIBUTOR_PULL;
      if (github) {
        github.serveNumbered({
          number,
          branch: "contribution",
          title: original.title,
          body: original.description,
          headSha: head,
          headRepo: "contributor/r",
          headRepoId: 99,
        });
        github.setChecks([{ name: "build", status: "completed", conclusion: "success" }]);
        seedGitHubSignIn(userDataDir);
      }
      if (gitlab) {
        number = gitlab.openMergeRequest({
          branch: "contribution",
          title: original.title,
          description: original.description,
          sourceProjectId: 99,
        });
        gitlab.protectMedia(true);
        seedGitLabSignIn(userDataDir, host);
      }
      const part = kind === "github" ? GITHUB_QUEUE_PART : GITLAB_QUEUE_PART;
      if (owned) {
        const files = shippedFiles(
          fileURLToPath(new URL("../../src/core/queue/shipped/", import.meta.url)),
          part,
        );
        if (github)
          github.serveWorkflows(
            files
              .filter((file) => file.path === part.queueFile)
              .map((file) => ({ path: file.path, state: "active", text: file.text })),
          );
        if (gitlab)
          gitlab.serveFiles({
            ...Object.fromEntries(files.map((file) => [file.path, file.text])),
            ".gitlab-ci.yml": `include:\n  - local: ${part.queueFile}\n`,
          });
      }
      const db = openDatabase(userDataDir);
      seedProject(db, {
        id: "repo-contributor",
        path: repoDir,
        name: "meterlab",
        setupKind: "clone",
        origin,
        runsOn: null,
        delivery: "queue-pr",
        rigor: "quick",
      });
      if (owned)
        new RepoRegistry(db, join(userDataDir, "fleet")).recordQueue("repo-contributor", {
          workflows: [{ path: part.queueFile, active: true, shipped: part.version }],
        });
      seedHostedOrigins(db, userDataDir);
      db.close();
      const scenario = contributorStory(number);
      const demo = await startDemo({
        userDataDir,
        withMockProvider: true,
        scenarios: [scenario],
        env: stub.env,
        size: { width: 1280, height: 1000 },
      });
      let launched = demo.launched;
      try {
        const { page } = launched;
        const input = promptInput(page);
        await input.fill(`${SPAWN_PROMPT_MARKER} meterlab ${CONTRIBUTOR_STORY_MARKER}`);
        await input.press("Enter");
        const card = shownCard(page, CONTRIBUTOR_STORY_TITLE);
        await expect(card).toBeVisible({ timeout: 45_000 });
        const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (task) => task.title.includes(CONTRIBUTOR_STORY_MARKER),
        );
        if (!task) throw new Error("The proof task was not recorded");
        const approval = () =>
          readSavedData(
            userDataDir,
            (db) => new TaskStore(db).get(task.id)?.delivery?.mergeAuthorization,
          );
        const comments = () => stub.comments(number);
        const text = () => stub.requestText(number);
        const queueReadings = () => github?.statuses(head) ?? gitlab?.statuses(head);
        const keepProof = (waiting = queueReadings()) =>
          test.info().attach(`${kind}-contributor-story-proof`, {
            body: JSON.stringify(
              {
                kind,
                queueVersion: owned ? part.version : null,
                request: number,
                head,
                original,
                after: text(),
                comments: comments(),
                waiting,
                approval: approval(),
                merges: stub.merges(),
                requests: stub.requests(),
              },
              null,
              2,
            ),
            contentType: "application/json",
          });
        expect(text()).toEqual(original);
        expect(comments()).toHaveLength(1);
        expect(comments()[0]?.body).toContain(
          `# ${presentationMarkdownText(CONTRIBUTOR_STORY_TITLE)}`,
        );
        expect(stub.merges()).toEqual([]);
        expect(approval()).toBeUndefined();
        await regionShot(card, test.info().outputPath(`${kind}-contributor-story.png`));
        await demo.record("Queue the contributor's story", "window", async () => {
          await demo.step(async () => {
            await pressKey(page.getByRole("button", { name: MERGE, exact: true }), "Enter");
            await expect.poll(approval).toMatchObject({ approvedHead: head, status: "standing" });
            // Accepted contributor flow: persistence precedes the asynchronous host mark.
            // Wait for that mark itself, never for a clock or another incidental event.
            try {
              await expect.poll(queueReadings).toContainEqual(
                expect.objectContaining(
                  github
                    ? { context: QUEUE_STATUS, state: "pending" }
                    : {
                        name: QUEUE_STATUS,
                        status: "skipped",
                        description: QUEUE_WAITING_WORDS,
                      },
                ),
              );
            } catch (error) {
              await keepProof();
              throw error;
            }
            await expectNoCard(page, CONTRIBUTOR_STORY_TITLE);
          });
        });
        expect(stub.merges()).toEqual([]);
        const waiting = queueReadings();
        await demo.finish({
          dir: test.info().outputPath("demo"),
          name: `${kind}-contributor-story`,
          format: "mp4",
        });
        const resultWords = owned
          ? passed(1, git("-C", repoDir, "rev-parse", `${head}^{tree}`))
          : "The batch passed.";
        if (github)
          github.setStatus(head, {
            context: QUEUE_STATUS,
            state: "success",
            ...(owned ? { description: resultWords } : {}),
          });
        if (gitlab)
          gitlab.setStatus(head, {
            name: QUEUE_STATUS,
            status: "success",
            description: resultWords,
          });
        if (owned) {
          expect(comments()).toHaveLength(2);
          expect(comments()[1]?.body).toContain("<!-- infinitary-merge-approval -->");
          await mergePassedFixture({
            kind,
            url: stub.url,
            project: fullName,
            base: git("-C", repoDir, "rev-parse", "main"),
          });
        }
        launched = await launchApp({
          userDataDir,
          withMockProvider: true,
          scenarios: [scenario],
          env: stub.env,
        });
        await expect.poll(() => stub.merges(), { timeout: 30_000 }).toHaveLength(1);
        await expect.poll(approval).toMatchObject({ status: "consumed", receipt: { head } });
        const summary = presentationCommitMessage(MOCK_GITHUB_STORY, BUNDLED_NAMING);
        if (github)
          expect(github.merges()).toEqual([
            {
              number,
              sha: head,
              method: "squash",
              title: CONTRIBUTOR_STORY_TITLE,
              message: summary,
            },
          ]);
        if (gitlab)
          expect(gitlab.merges()).toEqual([
            {
              iid: number,
              sha: head,
              squash: true,
              message: `${CONTRIBUTOR_STORY_TITLE}\n\n${summary}`,
            },
          ]);
        expect(text()).toEqual(original);
        expect(comments()).toHaveLength(owned ? 2 : 1);
        const requests = stub.requests();
        const nativeWrite =
          kind === "github"
            ? `PATCH /repos/${fullName}/pulls/${number}`
            : `PUT /api/v4/projects/${encodeURIComponent(fullName)}/merge_requests/${number}`;
        expect(requests).not.toContain(nativeWrite);
        await keepProof(waiting);
      } finally {
        await launched.close();
        await stub.close();
      }
    });
  }
}
