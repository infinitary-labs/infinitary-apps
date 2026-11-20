import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { deliveryFactsOf } from "../../src/shared/deliveryFacts";
import { softHoldWords } from "../../src/shared/holds";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { latestServedTurn } from "./providerRequest";
import { readSavedData } from "./savedData";
import { CLOSE_ALONE_MARKER, CLOSE_ON_WORDS_MARKER, doneClose } from "./scenarios/doneClose";
import { pressKey } from "./windowKeys";

/** The seeded task's title, named once where it goes in and where the first mate is asked. */
const TITLE = "Correct the meter";
/** The task's own pull request, open on the stand-in GitHub. */
const PULL = 55;

/**
 * INF-3169's plan, piece 2, the captain's picks: the delivery proof holds the
 * first mate's own close while the task's own pull request is still open
 * ("One hold your words pass: ... its own pull request is still open ..."),
 * and the captain's words close it as done, leaving the pull request "open
 * where the project lives, and say so on the record". The first mate's
 * judgment is scripted; its tool, the close, the saved record and the
 * stand-in GitHub it reads are real. No accounts or shared data are used.
 */
test("the first mate's own close holds for an open pull request, and the captain's words close it leaving the pull request open", async () => {
  const userDataDir = scratchDir("infinitary-done-close-");
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = "fm/task-meter";
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(worktreeDir, "meter.txt"), "The meter reads on time.\n");
  git("-C", worktreeDir, "add", "meter.txt");
  git("-C", worktreeDir, "commit", "-m", "fix: the meter reads on time");
  const headSha = git("-C", worktreeDir, "rev-parse", "HEAD").trim();

  const github = await startGitHubStub();
  // The task's own pull request reads open where the project lives.
  github.serveNumbered({ number: PULL, branch, title: "fix: the meter reads on time", headSha });
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meter",
    path: repoDir,
    name: "r",
    setupKind: "clone",
    origin: "https://github.com/o/r.git",
    runsOn: null,
    delivery: "direct-pr",
  });
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "meter",
    title: TITLE,
    status: "idle",
    outcome: `The meter reads on time; pull request #${PULL} is open.`,
    repoId: "repo-meter",
    repoDir,
    worktreeDir,
    branch,
  });
  seedDelivery(tasks, "meter", {
    mode: "direct-pr",
    prNumber: PULL,
    prUrl: `https://github.com/o/r/pull/${PULL}`,
    headSha,
  });
  db.close();

  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [doneClose],
    env: github.env,
  });
  try {
    const { page, mockProvider } = launched;
    const detail = () => page.evaluate(() => window.infinitary.tasks.detail("meter"));
    const toolResults = () =>
      (mockProvider?.requestBodies() ?? []).flatMap(
        (body) => latestServedTurn(body)?.toolResults ?? [],
      );

    // Closing on its own, the first mate meets the delivery proof hold.
    await promptInput(page).fill(`${CLOSE_ALONE_MARKER}${TITLE}`);
    await pressKey(promptInput(page), "Enter");
    const proofHold = softHoldWords("proof", "firstmate");
    await expect.poll(() => toolResults().some((text) => text.includes(proofHold))).toBe(true);
    expect(toolResults().find((text) => text.includes(proofHold))).toContain(`#${PULL}`);
    await expect.poll(detail).toMatchObject({ status: "active" });

    // The captain's words in this turn pass it: done, the pull request left open.
    await promptInput(page).fill(`${CLOSE_ON_WORDS_MARKER}${TITLE}`);
    await pressKey(promptInput(page), "Enter");
    await expect
      .poll(detail, { timeout: 20_000 })
      .toMatchObject({ status: "done", closedReason: "finished" });
    // The saved close event records the captain's word and the pull request it read.
    const close = readSavedData(userDataDir, (saved) =>
      (
        saved
          .prepare("SELECT data_json FROM task_events WHERE task_id = ? ORDER BY at, id")
          .all("meter") as { data_json: string | null }[]
      )
        .map((row) => (row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : {}))
        .find((data) => deliveryFactsOf(data).length > 0),
    );
    expect(close).toMatchObject({ why: "finished", onWord: true });
    const pullFact = deliveryFactsOf(close).find((fact) => fact.kind === "pull-request");
    expect(pullFact).toMatchObject({ basis: "checked" });
    expect(pullFact?.text).toContain(`#${PULL}`);
    // Nothing closed it where the project lives: it reads open there still.
    expect(
      github.requests().filter((request) => request.startsWith(`PATCH /repos/o/r/pulls/${PULL}`)),
    ).toEqual([]);
    expect(github.requests()).toContain(`GET /repos/o/r/pulls/${PULL}`);
  } finally {
    await launched.close();
  }
});
