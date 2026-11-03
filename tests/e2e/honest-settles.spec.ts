import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cannotMergeText } from "../../src/core/orchestrator/settleWords";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { DISCARDED_LINE } from "../../src/core/tasks/taskFeed";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  PROJECT_POLICY_WORDS,
  PROJECT_ROW_WORDS,
} from "../../src/renderer/src/settings/projectsWords";
import { forgeSignInTitle } from "../../src/shared/forges";
import { plainProblem } from "../../src/shared/plainProblem";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { seedHostedOrigins } from "./projectSeed";
import { projectRow, projectRowWords } from "./projects";
import { noteLines, statusLine, taskKey } from "./rails";
import { shownCard } from "./stack";

/**
 * Git integration PR 0.2, the captain's side of the Sep 24 evening
 * (report moment 5): a discard of a task that never opened a proposed
 * change printed "Could not close PR: spawn gh ENOENT", and a put-in the
 * project's host refused reached the feed as the tool's raw words.
 *
 * Real restored cards, a real git repository with a task worktree, the real
 * click, the real IPC and the persisted feed. The one stand-in is GitHub, a
 * local server the app reads through its own sign-in (`./githubStub.ts`)
 * that logs every request: for the discard it must never be asked at all,
 * and for the put-in it refuses the sign-in the way GitHub does when it no
 * longer accepts one (git integration PR 1.2) - which also raises the one
 * host card that says so.
 */

const SETTLE_MERGE = { kind: "settle", mode: "merge" } as const;
const SETTLE_DISCARD = { kind: "settle", mode: "discard" } as const;
/** The task the captain discards, and the one whose put-in the host refuses. */
const DISCARDED_TITLE = "Look into the meter";
const REFUSED_TITLE = "Put in the fix";
/** The host's one card for a sign-in GitHub refused. */
const SIGN_IN_AGAIN = forgeSignInTitle("GitHub");

function seedRepo(userDataDir: string, taskId: string, options: { commit: boolean }) {
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = `fm/task-${taskId}`;
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  if (options.commit) {
    // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
    writeFileSync(join(worktreeDir, "fix.txt"), "The crewmate's fix.\n");
    git("-C", worktreeDir, "add", "fix.txt");
    git("-C", worktreeDir, "commit", "-m", "fix: the crewmate's fix");
  }
  const headSha = git("-C", worktreeDir, "rev-parse", "HEAD").trim();
  return { repoDir, worktreeDir, branch, headSha };
}

function seedCompletionCard(db: ReturnType<typeof openDatabase>, taskId: string, title: string) {
  new CardStore(db).upsert({
    id: `card-${taskId}-1`,
    taskId,
    author: "crewmate",
    priority: 30,
    title,
    meta: "crewmate 1",
    body: "<p>The fix is ready.</p><p>It changes one file.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "put-in",
        label: "Merge the pull request",
        variant: "primary",
        default: true,
        effect: SETTLE_MERGE,
      },
      { id: "discard", label: "Discard", variant: "danger", danger: true, effect: SETTLE_DISCARD },
    ],
  });
}

async function feedTexts(page: Page): Promise<string[]> {
  const lines = await page.evaluate(() => window.infinitary.feed.recent());
  return lines.map((line) => line.text);
}

test("discarding a task that never opened a pull request asks GitHub nothing and says only that it is gone", async () => {
  const userDataDir = scratchDir("infinitary-quiet-discard-");
  const taskId = "neveropened";
  const repo = seedRepo(userDataDir, taskId, { commit: false });
  const github = await startGitHubStub();
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo-hosted", repo.repoDir, "hosted", Date.now(), "https://github.com/o/hosted.git");
  seedHostedOrigins(db, userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: DISCARDED_TITLE,
    status: "idle",
    repoId: "repo-hosted",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  seedCompletionCard(db, taskId, "The meter reads late");
  db.close();

  const launched = await launchApp({ userDataDir, env: github.env });
  try {
    const { page } = launched;
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    // The feed says it is gone on the task's own close line (INF-1845), and nothing about a pull request.
    const key = await taskKey(page, DISCARDED_TITLE);
    await expect(statusLine(page, key).filter({ hasText: DISCARDED_LINE })).toBeVisible({
      timeout: 20_000,
    });
    await expect(noteLines(page, key)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "dropped", closedReason: "discarded" });
    // Nothing was asked of GitHub: the task never opened a change.
    expect(github.requests()).toEqual([]);
    const feed = (await feedTexts(page)).join("\n");
    expect(feed).not.toMatch(/Could not close|ENOENT|\bgh\b|PR/);

    // Settings → Projects says only how the project differs from a new one:
    // its folder sits outside the projects folder, so the row calls it
    // linked and shows where it is (INF-1495).
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects" }).click();
    const header = page.getByRole("button", { name: "hosted, collapsed" });
    await expect(projectRowWords(page, "repo-hosted")).toHaveText([PROJECT_ROW_WORDS.linked]);
    await expect(header.locator("[data-project-path]")).toHaveText(repo.repoDir);
    await header.click();
    await expect(
      projectRow(page, "repo-hosted").getByText(PROJECT_POLICY_WORDS.delivery),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await launched.close();
    await github.close();
  }
});

test("a put-in the project's host refuses reads plainly in the feed, and the raw words stay on the record", async () => {
  const userDataDir = scratchDir("infinitary-plain-settle-");
  const taskId = "refusedmerge";
  const repo = seedRepo(userDataDir, taskId, { commit: true });
  const github = await startGitHubStub();
  // The crewmate's change, at its branch's own commit.
  github.servePull({ number: 71, title: "fix: the crewmate's fix" });
  github.headOf(() => repo.headSha);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo-hosted", repo.repoDir, "hosted", Date.now(), "https://github.com/o/hosted.git");
  seedHostedOrigins(db, userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: REFUSED_TITLE,
    status: "idle",
    repoId: "repo-hosted",
    repoDir: repo.repoDir,
    worktreeDir: repo.worktreeDir,
    branch: repo.branch,
  });
  seedCompletionCard(db, taskId, "The fix is ready");
  db.close();

  const launched = await launchApp({ userDataDir, env: github.env });
  try {
    const { page } = launched;
    // GitHub stops accepting the app's sign-in before the captain's click.
    github.rejectSignIn();
    await page.getByRole("button", { name: "Merge the pull request", exact: true }).click();
    // One click deeper, the record keeps exactly what the host said.
    const refusal = async () =>
      (await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))?.events
        .filter((event) => event.kind === "note")
        .map((event) => String(event.data?.problem ?? ""))
        .find(
          (problem) =>
            problem.includes("GitHub answered 401") && problem.includes("Bad credentials"),
        );
    await expect.poll(refusal, { timeout: 20_000 }).toBeDefined();
    // The feed says what that refusal means, never the host's raw words.
    const problem = (await refusal()) as string;
    await expect(
      noteLines(page, await taskKey(page, REFUSED_TITLE)).filter({
        hasText: cannotMergeText(plainProblem(problem)),
      }),
    ).toBeVisible({ timeout: 20_000 });
    // Nothing went in; the task stays open, its work kept.
    expect(github.merges()).toEqual([]);
    const feed = (await feedTexts(page)).join("\n");
    expect(feed).not.toMatch(/Bad credentials|\b401\b|PR merge blocked|\bgh\b|token/);
    expect(await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)).toMatchObject({
      status: "active",
    });
    // The host asked GitHub who the sign-in is, was refused, and raised
    // its one card: "sign in again", pointing at Settings -> Projects.
    await expect(shownCard(page, SIGN_IN_AGAIN)).toBeVisible({ timeout: 20_000 });
    const titles = (await page.evaluate(() => window.infinitary.cards.list())).map(
      (card) => card.title,
    );
    expect(titles.filter((title) => title === SIGN_IN_AGAIN)).toHaveLength(1);
  } finally {
    await launched.close();
    await github.close();
  }
});
