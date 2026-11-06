import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { keptFeedLine } from "../../src/core/orchestrator/mergeAuthorization";
import { settlingText } from "../../src/core/orchestrator/settleWords";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { launchClaudeCrew } from "./claudeCrew";
import {
  type GitHubStub,
  seedGitHubSignIn,
  seedRepo as seedHostedRepo,
  startGitHubStub,
} from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { recordAppTrace } from "./launchDiagnostics";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import { dockRegion, expandDock, noteLines, putInLine, taskKey } from "./rails";
import {
  GUIDED_MERGE_ANSWER,
  GUIDED_MERGE_ASK,
  GUIDED_MERGE_CARD,
  GUIDED_MERGE_MARKER,
  GUIDED_MERGE_QUESTION,
  GUIDED_MERGE_TITLE,
  guidedMerge,
} from "./scenarios/guidedMerge";
import {
  KEPT_MERGE_CARD,
  KEPT_MERGE_MARKER,
  KEPT_MERGE_ON_CLAUDE,
  KEPT_MERGE_TITLE,
  keptMerge,
} from "./scenarios/keptMerge";
import { cardLeave, cardReply, completionAction, expectNoCard, showCard, shownCard } from "./stack";

/**
 * Cards/tasks/agents P1 exit check: a completion card carries ONE merge
 * effect (`settle merge`), and the host resolves what that means from the
 * task's delivery posture - a PR merge on GitHub for a direct-pr repository,
 * a local landing otherwise. The Sep 4-5 dogfood card ("Merge PR 55", a
 * per-PR action id the host never dispatched on) merged nothing; the same
 * card re-emitted with the effect merges on either posture. Closing the
 * card is the keep: nothing lands, nothing goes, the crewmate stays idle.
 *
 * Real restored cards, a real git repository with a task worktree, the real
 * click through the card footer, the real IPC, and the persisted feed. The
 * only stand-in is GitHub itself (`./githubStub.ts`): a local server the app
 * reads through its own sign-in, which answers the change and its checks
 * the way GitHub's API would, and records the merge it is asked for.
 */

const SETTLE_MERGE = { kind: "settle", mode: "merge" } as const;
const SETTLE_DISCARD = { kind: "settle", mode: "discard" } as const;

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
  const mainLog = () => git("-C", repoDir, "log", "--oneline", "main");
  /** The task branch's commit now: the head of its change on GitHub. */
  const branchHead = () => git("-C", repoDir, "rev-parse", `refs/heads/${branch}`).trim();
  /** The crewmate pushes one more save point to the task's branch. */
  const push = (subject: string) =>
    git("-C", worktreeDir, "commit", "--allow-empty", "-m", subject);
  return { repoDir, worktreeDir, branch, headSha, mainLog, branchHead, push };
}

/** A commit id GitHub could hold that this Mac never fetched: hashed, never written. */
function commitNotHere(repoDir: string): string {
  const who = "Someone <someone@example.com> 1790000000 +0000";
  return execFileSync("git", ["-C", repoDir, "hash-object", "-t", "commit", "--stdin"], {
    input: `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor ${who}\ncommitter ${who}\n\nfeat: pushed from elsewhere\n`,
  })
    .toString()
    .trim();
}

/** The change GitHub holds for the task's branch, as its crewmate opened it. */
const CHANGE = {
  number: 55,
  title: "feat: the crewmate's work",
  body: "The crewmate's work, ready to go in.",
};

/** The Sep 4-5 completion card's title. */
const READY_CARD_TITLE = "The PR is ready";

/** The Sep 4-5 completion card, re-emitted with effects instead of reserved ids. */
function seedCompletionCard(
  db: ReturnType<typeof openDatabase>,
  taskId: string,
  mergeLabel: "Merge the pull request" | "Merge the branch",
) {
  new CardStore(db).upsert({
    id: `card-${taskId}-1`,
    taskId,
    author: "crewmate",
    priority: 30,
    title: READY_CARD_TITLE,
    meta: "crewmate 1",
    body: "<p>The work is ready to settle.</p><ul><li>CI is green on the head commit. https://github.com/o/r/pull/55</li></ul>",
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "merge-pr55",
        label: mergeLabel,
        variant: "primary",
        default: true,
        effect: SETTLE_MERGE,
      },
      { id: "discard", label: "Discard", variant: "danger", danger: true, effect: SETTLE_DISCARD },
    ],
  });
}

/** Historical ready/red entries remain readable but grant no current authority (captain INF-1555 F12). */
function seedHistoricalCheckDeclaration(
  db: ReturnType<typeof openDatabase>,
  taskId: string,
  headSha: string,
  verdict: "ready" | "red",
) {
  seedDelivery(new TaskService({ db, strict: true }), taskId, {
    ciRepair: {
      failures: [],
      diagnoses: [],
      repairs: [],
      declarations: [
        {
          headSha,
          verdict,
          at: Date.now(),
          evidence: "The scripted crew judged the arranged check runs for this candidate.",
        },
      ],
    },
  });
}

/**
 * Captain F26: checks that pass, including a later run replacing a cancelled duplicate. The second is PR #632's version (FI3-585):
 * one push started two runs of the same workflow, the later run cancelled
 * the earlier before it began, and the later run's check passed.
 */
const PASSING: { checks: string; runs?: Parameters<GitHubStub["setChecks"]>[0] }[] = [
  { checks: "passed" },
  {
    checks: "passed in a later run after a duplicate run was cancelled",
    runs: [
      { name: "linux-checks", status: "completed", conclusion: "cancelled", run: 41 },
      { name: "linux-checks", status: "completed", conclusion: "success", run: 42 },
    ],
  },
];

for (const passing of PASSING) {
  test(`a settle merge effect on a direct-pr task whose checks ${passing.checks} merges the PR on GitHub, never landing locally`, async () => {
    const userDataDir = scratchDir("infinitary-settle-pr-");
    const taskId = "prtask";
    const repo = seedRepo(userDataDir, taskId);
    const github = await startGitHubStub();
    github.servePull(CHANGE);
    if (passing.runs) github.setChecks(passing.runs);
    github.headOf(() => repo.branchHead());
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
      title: "Ship the PR",
      status: "idle",
      repoId: "repo-pr",
      repoDir: repo.repoDir,
      worktreeDir: repo.worktreeDir,
      branch: repo.branch,
    });
    seedCompletionCard(db, taskId, "Merge the pull request");
    db.close();

    const launched = await launchApp({ userDataDir, env: github.env });
    try {
      const { page } = launched;
      await expect(shownCard(page, READY_CARD_TITLE)).toBeVisible();
      // Activity is mounted before the click, so its lines are read as they land.
      await expandDock(page, "activity");
      await page.getByRole("button", { name: "Merge the pull request", exact: true }).click();
      // The click is acknowledged at once, in a line on the task, and the
      // outcome takes that line's place: the task's own put-in line
      // (INF-1845). The words are cardActions.settle.test.ts's and changeMerge.test.ts's.
      await expectNoCard(page, READY_CARD_TITLE);
      const key = await taskKey(page, "Ship the PR");
      await expect(putInLine(page, key)).toBeVisible({ timeout: 20_000 });
      await expect(
        noteLines(page, key).filter({ hasText: settlingText("merge-pr", "#55", false) }),
      ).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("settle-merge-put-in.png") });
      // GitHub was asked to squash exactly that PR at exactly the branch's
      // head, under its own title, and the local checkout was never touched:
      // main still has only its init.
      expect(github.merges()).toEqual([
        {
          number: 55,
          sha: repo.headSha,
          method: "squash",
          title: CHANGE.title,
          message: CHANGE.body,
        },
      ]);
      expect(repo.mainLog()).not.toContain("the crewmate's work");
      await expect
        .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
        .toMatchObject({ status: "done", closedReason: "merged" });
    } finally {
      await launched.close();
      await github.close();
    }
  });
}

type Repo = ReturnType<typeof seedRepo>;

/** What the task's record says stopped a put-in: its notes' problems, and its checks. */
function stopOf(task: TaskDetail | null): { problem: string; ci: string | undefined } {
  const notes = (task?.events ?? []).filter((event) => event.kind === "note");
  return {
    problem: notes.map((event) => String(event.data?.problem ?? "")).join("\n"),
    ci: task?.delivery?.ci,
  };
}

/**
 * Changes that must not go in, each one fact away from the happy path above
 * (which does go in): what is wrong with it, whether the app gets as far as
 * asking GitHub to merge (only GitHub sees a head that moved after the
 * check), and the fact the task's record keeps about why it stopped - read
 * off the spec's own inputs, never the refusal's wording.
 */
const REFUSALS: {
  change: string;
  arrange: (github: GitHubStub, repo: Repo) => string;
  asksGitHub: boolean;
  crewVerdict: "ready" | "red";
  crewHead?: (repo: Repo, fact: string) => string;
  stoppedBy: (stop: ReturnType<typeof stopOf>, fact: string) => boolean;
}[] = [
  {
    change: "an unconventional title",
    arrange: (github) => {
      github.servePull({ ...CHANGE, title: "The crewmate's work" });
      return JSON.stringify("The crewmate's work");
    },
    asksGitHub: false,
    crewVerdict: "ready",
    stoppedBy: (stop, title) => stop.problem.includes(title),
  },
  {
    change: "no title",
    arrange: (github) => {
      github.servePull({ ...CHANGE, title: "" });
      return JSON.stringify("");
    },
    asksGitHub: false,
    crewVerdict: "ready",
    stoppedBy: (stop, title) => stop.problem.includes(title),
  },
  {
    change: "a head this Mac does not have",
    arrange: (github, repo) => {
      const elsewhere = commitNotHere(repo.repoDir);
      github.servePull(CHANGE);
      github.headOf(() => elsewhere);
      return elsewhere;
    },
    crewHead: (_repo, fact) => fact,
    asksGitHub: false,
    crewVerdict: "ready",
    stoppedBy: (stop, head) => stop.problem.includes(head),
  },
  {
    change: "a head that moved on between the check and the put-in",
    arrange: (github, repo) => {
      github.servePull(CHANGE);
      github.onMergeRequest(() => repo.push("feat: one more thing"));
      return "GitHub answered 409";
    },
    asksGitHub: true,
    crewVerdict: "ready",
    stoppedBy: (stop, answer) => stop.problem.includes(answer),
  },
  {
    change: "failing checks",
    arrange: (github) => {
      github.servePull(CHANGE);
      github.setChecks([{ name: "linux-checks", status: "completed", conclusion: "failure" }]);
      return "red";
    },
    asksGitHub: false,
    crewVerdict: "red",
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
  {
    change: "a check that failed in a later run after a duplicate run was cancelled",
    arrange: (github) => {
      github.servePull(CHANGE);
      github.setChecks([
        { name: "linux-checks", status: "completed", conclusion: "cancelled", run: 41 },
        { name: "linux-checks", status: "completed", conclusion: "failure", run: 42 },
      ]);
      return "red";
    },
    asksGitHub: false,
    crewVerdict: "red",
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
];

for (const refusal of REFUSALS) {
  test(`a settle merge on a change with ${refusal.change} puts nothing in and leaves the task open`, async () => {
    const userDataDir = scratchDir("infinitary-settle-refused-");
    const taskId = "refusedtask";
    const repo = seedRepo(userDataDir, taskId);
    const github = await startGitHubStub();
    github.headOf(() => repo.branchHead());
    const fact = refusal.arrange(github, repo);
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
      title: "Ship the PR",
      status: "idle",
      repoId: "repo-pr",
      repoDir: repo.repoDir,
      worktreeDir: repo.worktreeDir,
      branch: repo.branch,
    });
    seedHistoricalCheckDeclaration(
      db,
      taskId,
      refusal.crewHead?.(repo, fact) ?? repo.branchHead(),
      refusal.crewVerdict,
    );
    seedCompletionCard(db, taskId, "Merge the pull request");
    db.close();

    const launched = await launchApp({ userDataDir, env: github.env });
    try {
      const { page } = launched;
      await expandDock(page, "activity");
      await page.getByRole("button", { name: "Merge the pull request", exact: true }).click();
      const key = await taskKey(page, "Ship the PR");
      await expect(noteLines(page, key)).toHaveCount(1);
      // The record says why it stopped, in terms of what this change got wrong.
      const detail = () => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
      await expect
        .poll(async () => refusal.stoppedBy(stopOf(await detail()), fact), { timeout: 20_000 })
        .toBe(true);
      // Nothing went in: GitHub merged nothing (and was asked only when the
      // head moved under it), main is untouched, and the task is still open
      // with its work on its branch.
      expect(github.merges()).toEqual([]);
      expect(github.requests().filter((request) => request.endsWith("/merge"))).toHaveLength(
        refusal.asksGitHub ? 1 : 0,
      );
      expect(repo.mainLog()).not.toContain("the crewmate's work");
      // The feed says so: the task's one settle line is the refusal now, and no put-in line.
      await expect(noteLines(page, key)).toHaveCount(1);
      await expect(noteLines(page, key)).toContainText(/Cannot merge|Your merge/);
      await expect(putInLine(page, key)).toHaveCount(0);
      expect(await detail()).toMatchObject({ status: "active", closedReason: null });
      expect((await detail())?.delivery?.landedMode).toBeUndefined();
      expect(existsSync(join(repo.worktreeDir, "feature.txt"))).toBe(true);
    } finally {
      await launched.close();
      await github.close();
    }
  });
}

test("the same settle merge effect on a local-only task lands the branch into the checkout", async () => {
  const userDataDir = scratchDir("infinitary-settle-land-");
  const taskId = "localtask";
  const repo = seedRepo(userDataDir, taskId);
  const github = await startGitHubStub();
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  // No repo row: the task's posture is local-only.
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: "Land the branch",
    status: "idle",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  seedCompletionCard(db, taskId, "Merge the branch");
  db.close();

  const launched = await launchApp({ userDataDir, env: github.env });
  try {
    const { page } = launched;
    await expandDock(page, "activity");
    await page.getByRole("button", { name: "Merge the branch", exact: true }).click();
    await expectNoCard(page, READY_CARD_TITLE);
    await expect(putInLine(page, await taskKey(page, "Land the branch"))).toBeVisible({
      timeout: 20_000,
    });
    // The branch is on main, the worktree is retired, and GitHub was never
    // asked about the project (the boot's one "who is this" read aside).
    expect(repo.mainLog()).toContain("the crewmate's work");
    await expect.poll(() => existsSync(repo.worktreeDir), { timeout: 15_000 }).toBe(false);
    expect(github.merges()).toEqual([]);
    expect(github.requests().filter((request) => request.includes("/repos/"))).toEqual([]);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "done", closedReason: "landed" });
  } finally {
    await launched.close();
    await github.close();
  }
});

test("closing a settle card is the keep: nothing lands, nothing goes, the crewmate stays idle", async () => {
  const userDataDir = scratchDir("infinitary-settle-keep-");
  const taskId = "keeptask";
  const repo = seedRepo(userDataDir, taskId);
  const db = openDatabase(userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: "Keep the work",
    status: "idle",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  seedCompletionCard(db, taskId, "Merge the branch");
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    // There is no keep button: the card offers exactly its two effects.
    await expect(page.getByRole("button", { name: "Merge the branch", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Keep" })).toHaveCount(0);
    await expandDock(page, "activity");
    await cardLeave(page).click();
    await expect(shownCard(page, READY_CARD_TITLE)).toBeHidden();
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.title === READY_CARD_TITLE,
      )?.minimized,
    ).toBe(true);
    expect(repo.mainLog()).not.toContain("the crewmate's work");
    expect(existsSync(join(repo.worktreeDir, "feature.txt"))).toBe(true);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "active", closedReason: null });
  } finally {
    await launched.close();
  }
});

/** The stand-in's scripted moves for both merge journeys below. */
const MERGE_SCENARIOS = [keptMerge, guidedMerge];

/** Keep the unfinished repair's facts too, not just the final polling timeout (INF-1342). */
function keepMergeFailure(app: LaunchedApp, tasks: TaskService, github: GitHubStub): void {
  writeFileSync(
    test.info().outputPath("merge-failure.json"),
    JSON.stringify(
      {
        tasks: tasks.listLive().map((task) => ({ ...task, timeline: tasks.timeline(task.id) })),
        messages: app.mockProvider?.requestBodies().map((body) => providerMessages(body)),
        requests: github.requests(),
        merges: github.merges(),
      },
      null,
      2,
    ),
  );
}

/**
 * FI3-304's journey: the captain clicks merge once, GitHub refuses it for a
 * conflict with newer work (a 405), and the change still merges exactly
 * once - after its crewmate brought it up to date and declared the repair -
 * with no second card and no second click. The app, its forge, its tools,
 * its card and its settle are real; the model's moves are scripted
 * (`scenarios/keptMerge.ts`) and GitHub is the local stand-in. It runs on both
 * backends a crewmate works on (FI3-664): Pi, and Claude's own client
 * against the mock provider (`./claudeCrew.ts`), whose tools - check_change's
 * conflictRepair among them - cross that client's tool protocol.
 */
const CREW_BACKENDS: {
  crew: string;
  words: string;
  claude: boolean;
  launch: (userDataDir: string, env: Record<string, string>) => Promise<LaunchedApp>;
}[] = [
  {
    crew: "a Pi crewmate",
    words: KEPT_MERGE_MARKER,
    claude: false,
    launch: (userDataDir, env) =>
      launchApp({ withMockProvider: true, scenarios: MERGE_SCENARIOS, userDataDir, env }),
  },
  {
    crew: "a Claude crewmate",
    words: `${KEPT_MERGE_MARKER} ${KEPT_MERGE_ON_CLAUDE}`,
    claude: true,
    launch: (userDataDir, env) =>
      launchClaudeCrew({ scenarios: MERGE_SCENARIOS, userDataDir, env }),
  },
];

for (const backend of CREW_BACKENDS) {
  test(`one merge click survives GitHub's conflict refusal and merges the brought-up-to-date change once, on ${backend.crew}`, async () => {
    const userDataDir = scratchDir("infinitary-kept-merge-");
    const { repoDir } = seedHostedRepo(userDataDir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" })
        .toString()
        .trim();
    const github = await startGitHubStub();
    github.headOf((branch) => git("rev-parse", `refs/heads/${branch}`));
    seedGitHubSignIn(userDataDir);
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db });
    const cards = new CardStore(db);
    seedProject(db, {
      id: "repo-meterlab",
      path: repoDir,
      name: "meterlab",
      setupKind: "clone",
      origin: "https://github.com/o/meterlab.git",
      runsOn: null,
      delivery: "direct-pr",
      rigor: "quick",
    });
    seedHostedOrigins(db, userDataDir);
    const app = await backend.launch(userDataDir, github.env);
    const title = `meterlab ${backend.words}`;
    let taskId = "";
    const record = () => tasks.get(taskId);
    try {
      const { page } = app;
      const input = promptInput(page);
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      // The crewmate commits, opens its pull request and puts its card up.
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title),
          { timeout: 45_000 },
        )
        .toContain(KEPT_MERGE_CARD);
      taskId =
        (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (task) => task.title === title,
        )?.id ?? "";
      const approved = record()?.delivery?.headSha ?? "";
      expect(approved).not.toBe("");
      // Newer work lands on main after the card went up: GitHub now finds the
      // change in conflict until it carries that work.
      writeFileSync(join(repoDir, "newer.txt"), "newer work on main\n");
      git("add", "newer.txt");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "feat: newer work",
      );
      const newer = git("rev-parse", "main");
      github.conflicts((head) => {
        try {
          git("merge-base", "--is-ancestor", newer, head);
          return false;
        } catch {
          return true;
        }
      });

      await expandDock(page, "activity");
      await (await completionAction(page, KEPT_MERGE_CARD)).click();
      // GitHub refused it, and the click is kept rather than spent.
      await expect(
        noteLines(page, await taskKey(page, title)).filter({
          hasText: keptFeedLine("conflict", "GitHub"),
        }),
      ).toBeVisible({
        timeout: 20_000,
      });
      await page.screenshot({ path: test.info().outputPath("kept-merge-refused.png") });

      // The Firstmate steered the repair; the host merged once it was declared.
      await expect.poll(() => record()?.closedReason ?? null, { timeout: 45_000 }).toBe("merged");
      // The repaired head is the crewmate's rebase: it carries main's newer work.
      // (The closed task's branch is retired, so it is read off the record.)
      const repaired = record()?.delivery?.mergeAuthorization?.lineage[0]?.toHead ?? "";
      expect(repaired).not.toBe(approved);
      git("merge-base", "--is-ancestor", newer, repaired);
      expect(github.merges()).toEqual([
        expect.objectContaining({ sha: repaired, method: "squash", title: KEPT_MERGE_TITLE }),
      ]);
      // One refused request and one accepted: never a merge sent twice.
      expect(github.requests().filter((request) => request.endsWith("/merge"))).toHaveLength(2);
      expect(record()?.delivery?.mergeAuthorization).toMatchObject({
        status: "consumed",
        approvedHead: approved,
        lineage: [{ fromHead: approved, toHead: repaired, newBase: newer, impact: "none" }],
        receipt: { head: repaired },
      });
      // The one card the task ever showed is the one clicked: no second ask.
      expect(cards.forTask(taskId).map((card) => card.title)).toEqual([KEPT_MERGE_CARD]);
      expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
      await expect(putInLine(page, await taskKey(page, title))).toBeVisible({ timeout: 20_000 });
      // The crewmate ran on the backend this case names: its turns went
      // through Claude's own client exactly when it is the Claude case.
      const claudeTurns = (app.mockProvider?.requestHeaders() ?? []).filter((headers) =>
        headers["user-agent"]?.startsWith("claude-cli/"),
      );
      expect(claudeTurns.length > 0).toBe(backend.claude);
      expect(record()?.model?.startsWith("anthropic-claude/") ?? false).toBe(backend.claude);
      await page.screenshot({ path: test.info().outputPath("kept-merge-merged.png") });
      writeFileSync(
        test.info().outputPath("kept-merge-evidence.json"),
        JSON.stringify(
          {
            model: record()?.model,
            claudeTurns: claudeTurns.length,
            delivery: record()?.delivery,
            timeline: tasks.timeline(taskId),
            requests: github.requests(),
            merges: github.merges(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      keepMergeFailure(app, tasks, github);
      throw error;
    } finally {
      await app.close();
      await github.close();
      db.close();
    }
  });
}

for (const backend of CREW_BACKENDS) {
  test(`the captain's guidance holds his kept merge until its crewmate declares its impact, on ${backend.crew}`, async () => {
    const userDataDir = scratchDir("infinitary-guided-merge-");
    const { repoDir } = seedHostedRepo(userDataDir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" })
        .toString()
        .trim();
    const github = await startGitHubStub();
    github.headOf((branch) => git("rev-parse", `refs/heads/${branch}`));
    seedGitHubSignIn(userDataDir);
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db });
    seedProject(db, {
      id: "repo-meterlab",
      path: repoDir,
      name: "meterlab",
      setupKind: "clone",
      origin: "https://github.com/o/meterlab.git",
      runsOn: null,
      delivery: "direct-pr",
      rigor: "quick",
    });
    seedHostedOrigins(db, userDataDir);
    const app = await backend.launch(userDataDir, github.env);
    const title = `meterlab ${GUIDED_MERGE_MARKER}${backend.claude ? ` ${KEPT_MERGE_ON_CLAUDE}` : ""}`;
    let taskId = "";
    const record = () => tasks.get(taskId);
    const mergeRequests = () => github.requests().filter((request) => request.endsWith("/merge"));
    let stopTrace: (() => Promise<void>) | undefined;
    try {
      // INF-1555 F16: retain real frame/network facts if Activity stops, not just test-call tracing.
      stopTrace = await recordAppTrace(
        app.app.context(),
        test.info().outputPath("guided-merge-app-trace.zip"),
      );
      const { page } = app;
      const input = promptInput(page);
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title),
          { timeout: 45_000 },
        )
        .toContain(GUIDED_MERGE_CARD);
      taskId =
        (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (task) => task.title === title,
        )?.id ?? "";
      const approved = record()?.delivery?.headSha ?? "";
      expect(approved).not.toBe("");
      // Newer work lands on main: GitHub refuses the click until the change carries it.
      writeFileSync(join(repoDir, "newer.txt"), "newer work on main\n");
      git("add", "newer.txt");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "feat: newer work",
      );
      const newer = git("rev-parse", "main");
      github.conflicts((head) => {
        try {
          git("merge-base", "--is-ancestor", newer, head);
          return false;
        } catch {
          return true;
        }
      });
      await expandDock(page, "activity");
      await (await completionAction(page, GUIDED_MERGE_CARD)).click();
      await expect(
        noteLines(page, await taskKey(page, title)).filter({
          hasText: keptFeedLine("conflict", "GitHub"),
        }),
      ).toBeVisible({
        timeout: 20_000,
      });

      // While his approval stands, the captain asks through the Firstmate.
      // The crewmate brings the change up to date, declares that repair and
      // asks him back on a card: it has not said what his words change.
      await input.fill(GUIDED_MERGE_ASK);
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title),
          { timeout: 45_000 },
        )
        .toContain(GUIDED_MERGE_QUESTION);
      // Its turn is over and the repaired change could merge, but the
      // host holds it on his guidance instead.
      await expect
        .poll(() => record()?.delivery?.mergeAuthorization?.waiting?.on ?? record()?.closedReason, {
          timeout: 30_000,
        })
        .toBe("guidance");
      const repaired = record()?.delivery?.mergeAuthorization?.lineage[0]?.toHead ?? "";
      expect(repaired).not.toBe(approved);
      expect(record()?.status).not.toBe("done");
      expect(mergeRequests()).toHaveLength(1);
      await regionShot(
        dockRegion(page, "activity"),
        test.info().outputPath("guided-merge-held.png"),
      );

      // His reply under the crewmate's card is guidance too. The crewmate
      // declares the newest guidance it read leaves the approved change as
      // it was, and the host merges the repaired head once.
      await showCard(page, GUIDED_MERGE_QUESTION);
      await cardReply(page).field.click();
      await cardReply(page).field.fill(GUIDED_MERGE_ANSWER);
      await cardReply(page).send.click();
      await expect.poll(() => record()?.closedReason ?? null, { timeout: 45_000 }).toBe("merged");
      expect(github.merges()).toEqual([
        expect.objectContaining({ sha: repaired, method: "squash", title: GUIDED_MERGE_TITLE }),
      ]);
      expect(mergeRequests()).toHaveLength(2);
      expect(record()?.delivery?.mergeAuthorization).toMatchObject({
        status: "consumed",
        approvedHead: approved,
        lineage: [{ fromHead: approved, toHead: repaired, impact: "none" }],
        guidance: { latest: 2, declared: 2 },
        receipt: { head: repaired },
      });
      await expect(putInLine(page, await taskKey(page, title))).toBeVisible({ timeout: 20_000 });
      await regionShot(
        dockRegion(page, "activity"),
        test.info().outputPath("guided-merge-merged.png"),
      );
      writeFileSync(
        test.info().outputPath("guided-merge-evidence.json"),
        JSON.stringify(
          {
            model: record()?.model,
            delivery: record()?.delivery,
            timeline: tasks.timeline(taskId),
            requests: github.requests(),
            merges: github.merges(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      keepMergeFailure(app, tasks, github);
      throw error;
    } finally {
      try {
        await stopTrace?.();
      } finally {
        await app.close();
        await github.close();
        db.close();
      }
    }
  });
}
