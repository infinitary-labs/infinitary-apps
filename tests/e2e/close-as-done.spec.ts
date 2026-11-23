import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { DELIVERY_BASIS_WORDS, DELIVERY_FACTS_LABEL } from "../../src/shared/deliveryFacts";
import { CLOSE_DONE_LABEL, closeDoneConfirm } from "../../src/shared/recordCloseDone";
import { DROP_CANCEL_LABEL } from "../../src/shared/recordDrop";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { pressRow, recordBar, recordCard } from "./rails";
import { pressKey, runFromSearch } from "./windowKeys";

/** The seeded task's own pull request, open on the stand-in GitHub. */
const PULL = 55;

/**
 * INF-3169's plan, piece 3: "a Close as done button on a started task's
 * record with one confirm", reached from command search too, and the
 * delivery facts the close read shown on the record, in its Delivered
 * row. The captain's picks keep an open pull request open. The
 * record, the host's close, the saved record and the stand-in GitHub it
 * reads are real; no model turn runs and no account or shared data is used.
 */
test("Close as done on a started task's record asks once, closes it on the captain's word and shows how it was delivered", async () => {
  const userDataDir = scratchDir("infinitary-close-as-done-");
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = "fm/task-meter";
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project files this journey commits and keeps.
  writeFileSync(join(worktreeDir, "meter.txt"), "The meter reads on time.\n");
  git("-C", worktreeDir, "add", "meter.txt");
  git("-C", worktreeDir, "commit", "-m", "fix: the meter reads on time");
  const headSha = git("-C", worktreeDir, "rev-parse", "HEAD").trim();

  const github = await startGitHubStub();
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
    title: "Correct the meter",
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

  const launched = await launchApp({ userDataDir, withMockProvider: true, env: github.env });
  try {
    const { app, page } = launched;
    const detail = () => page.evaluate(() => window.infinitary.tasks.detail("meter"));
    const key = (await detail()).key as string;

    await pressRow(page, key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "meter");
    const closeDone = recordBar(page).locator("[data-record-close-done]");
    await expect(closeDone).toHaveText(CLOSE_DONE_LABEL);

    await runFromSearch(app, page, "task.close-done");
    const confirm = recordBar(page).locator('[data-record-confirm="close-done"]');
    await expect(confirm).toHaveText(closeDoneConfirm(key));
    const cancel = recordBar(page).getByRole("button", { name: DROP_CANCEL_LABEL });
    await expect(cancel).toBeFocused();
    await pressKey(cancel, "Enter");
    await expect(confirm).toHaveCount(0);
    expect(await detail()).toMatchObject({ status: "active" });

    await runFromSearch(app, page, "task.close-done");
    await expect(confirm).toBeVisible();
    const yes = recordBar(page).locator("[data-record-close-done-confirm]");
    await pressKey(yes, "Enter");
    await expect
      .poll(detail, { timeout: 20_000 })
      .toMatchObject({ status: "done", closedReason: "finished", closing: { onWord: true } });

    await expect(recordCard(page)).toHaveAttribute("data-task-record", "meter");
    const delivery = recordCard(page).locator('[data-record-row="delivered"]');
    await expect(delivery.locator("[data-task-fact-label]")).toHaveText(DELIVERY_FACTS_LABEL);
    const pullFact = delivery.locator('[data-record-delivery-fact="checked"]', {
      hasText: `#${PULL}`,
    });
    await expect(pullFact).toContainText(DELIVERY_BASIS_WORDS.checked);
    await expect(recordBar(page).locator("[data-record-close-done]")).toHaveCount(0);

    expect(
      github.requests().filter((request) => request.startsWith(`PATCH /repos/o/r/pulls/${PULL}`)),
    ).toEqual([]);
    expect(github.requests()).toContain(`GET /repos/o/r/pulls/${PULL}`);
  } finally {
    await launched.close();
  }
});
