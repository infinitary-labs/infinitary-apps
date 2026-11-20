import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { shownCard } from "./stack";

/**
 * The gate the sanitizer's removal came with (captain decision, 2026-09-15,
 * point 2): an effect-bearing action - settle, open, or a host op - is the
 * host chrome's own button and is never declared to the card's frame, so a
 * card script cannot run one. It is the one live vector the sanitizer never
 * touched: a prompt-injected or over-eager crewmate could otherwise merge
 * its own PR at mount, before the captain had read the card.
 *
 * The card here is the Sep 4-5 completion card with a body that tries it,
 * on a real repository with a real task worktree. Nothing stands in except
 * `gh`, which would record a merge if one were ever asked for.
 */

const SETTLE_MERGE = { kind: "merge", after: "close" } as const;
/** The completion card whose body tries the settle. */
const CARD_TITLE = "The work is ready";

test("a card script calling inf.action for a settle at mount does not settle the task", async () => {
  const userDataDir = scratchDir("infinitary-effect-gate-");
  const taskId = "gatetask";
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

  const db = openDatabase(userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: taskId,
    title: "Land the branch",
    status: "idle",
    repoDir,
    worktreeDir,
    branch,
  });
  new CardStore(db).upsert({
    id: `card-${taskId}-1`,
    taskId,
    author: "crewmate",
    priority: 30,
    title: CARD_TITLE,
    meta: "crewmate 1",
    // The body attempts its host-run settle as soon as it mounts.
    body:
      "<p>The work is ready to settle.</p><p role='status'>pending</p>" +
      "<script>inf.action('land-it').then(function () {" +
      "document.querySelector('[role=status]').textContent = 'settled';" +
      "}, function (error) {" +
      "document.querySelector('[role=status]').textContent = error.code;" +
      "});" +
      "</script>",
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "land-it",
        label: "Merge the branch",
        variant: "primary",
        default: true,
        effect: SETTLE_MERGE,
      },
    ],
  });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await expect(shownCard(page, CARD_TITLE)).toBeVisible();
    const frame = cardBody(page, CARD_TITLE);
    // The host refuses the settle because it was never declared to the
    // frame; the rejection proves that the bridge is live.
    await expect(frame.getByRole("status")).toHaveText("action_not_declared", { timeout: 20_000 });

    // Nothing landed: main is still its init commit, the worktree stands,
    // the card is still on the stack, and the task is still active.
    expect(git("-C", repoDir, "log", "--oneline", "main")).not.toContain("the crewmate's work");
    expect(existsSync(join(worktreeDir, "feature.txt"))).toBe(true);
    await expect(shownCard(page, CARD_TITLE)).toBeVisible();
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "active", closedReason: null });

    // The captain's own click, on the host's chrome, still settles it.
    await page.getByRole("button", { name: "Merge the branch", exact: true }).click();
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId), {
        timeout: 30_000,
      })
      .toMatchObject({ status: "done", closedReason: "landed" });
    expect(git("-C", repoDir, "log", "--oneline", "main")).toContain("the crewmate's work");
  } finally {
    await launched.close();
  }
});
