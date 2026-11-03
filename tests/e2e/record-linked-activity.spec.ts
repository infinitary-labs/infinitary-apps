import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import { seedDelivery } from "../helpers/taskDelivery";
import { waitForFirstmateIdle } from "./crew";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import { expandDock, linkedTaskKeys, nowRow, recordCard, recordFrame } from "./rails";
import { completionAction } from "./stack";
import { focusOn, pressKey, pressWindowKey, typeInto, untilFocused } from "./windowKeys";

/**
 * A task's Activity holds what happened to the tasks linked to it
 * (FI3-1189's rule 1; docs/task-record.md, "Whom an event concerns"). The
 * journey the plan names: a task files a follow-up, Firstmate drops the
 * follow-up for a replacement, the captain merges the replacement, and the
 * first task's record lists all three - and its key opens the other record.
 */

const CHANGE = { number: 977, title: "fix: stop the work-posture hang", body: "The fix." };

function seeded() {
  const userDataDir = scratchDir("infinitary-linked-activity-");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = "fm/task-fix";
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(worktreeDir, "fix.txt"), "The fix.\n");
  git("-C", worktreeDir, "add", "fix.txt");
  git("-C", worktreeDir, "commit", "-m", CHANGE.title);
  const head = () => git("-C", repoDir, "rev-parse", `refs/heads/${branch}`).trim();
  const originWork = join(userDataDir, "origin-work");
  mkdirSync(originWork, { recursive: true });

  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo-fm", repoDir, "r", Date.now(), "https://github.com/o/r.git");
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const origin = seedTask(tasks, {
    id: "origin",
    title: "Cut the practice alpha",
    status: "idle",
    worktreeDir: originWork,
  });
  // The origin's crewmate files the follow-up through the one writer, as
  // its file_followup does.
  const followup = tasks.fileFollowup({
    id: "hang",
    originId: "origin",
    title: "Work-posture journey can hang",
    goal: "The work-posture journey finishes on the Mac.",
    prompt: "",
    why: "The Mac check hung on work-posture:71.",
  }).record;
  const fix = seedTask(tasks, {
    id: "fix",
    title: "Stop the work-posture hang",
    status: "idle",
    repoId: "repo-fm",
    repoDir,
    worktreeDir,
    branch,
  });
  seedDelivery(
    tasks,
    "fix",
    { prNumber: CHANGE.number, changeLabel: `#${CHANGE.number}` },
    { kind: "pr_opened", text: `PR #${CHANGE.number}` },
  );
  new CardStore(db).upsert({
    id: "card-fix-1",
    taskId: "fix",
    author: "crewmate",
    priority: 30,
    title: "The hang fix is ready",
    meta: "crewmate 2",
    body: "<p>The checks passed on the fix.</p>",
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
  return { userDataDir, head, origin, followup, fix };
}

/** The captain's words, typed in the input; the scripted Firstmate answers with these calls. */
async function ask(app: LaunchedApp, words: string, calls: ScriptedCall[]) {
  if (!app.mockProvider) throw new Error("The journey needs the mock provider");
  await waitForFirstmateIdle(app.page);
  const answer = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    calls,
  );
  const input = promptInput(app.page);
  await pressWindowKey(app.app, "l", ["meta"]);
  await expect(input).toBeFocused();
  await typeInto(input, words);
  await input.press("Enter");
  await expect
    .poll(answer.outcome, { timeout: 30_000 })
    .toMatchObject({ state: "closed", results: calls.map(() => expect.any(String)) });
  return answer.outcome();
}

test("a task's record lists its follow-up's drop for a replacement and that replacement's merge, and opens it by key", async () => {
  const seed = seeded();
  const github = await startGitHubStub();
  github.servePull(CHANGE);
  github.headOf(seed.head);
  seedGitHubSignIn(seed.userDataDir);
  const app = await launchApp({
    userDataDir: seed.userDataDir,
    env: github.env,
    withMockProvider: true,
  });
  try {
    const { page } = app;
    const detail = (id: string): Promise<TaskDetail> =>
      page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
    const [hang, fix] = [seed.followup.key, seed.fix.key];

    // Firstmate closes the follow-up for its replacement: done through it,
    // since the replacement carries on its work (INF-1825).
    const dropped = await ask(app, `Drop ${hang}; ${fix} does its work.`, [
      {
        name: "update_task",
        args: { task: hang, drop: true, reason: "the fix is its own task", replaced_by: fix },
      },
    ]);
    expect(dropped.results[0]).toContain(`${fix} carries on its work`);
    // The captain merges the replacement.
    await (await completionAction(page, "The hang fix is ready")).click();
    await expect
      .poll(() => detail("fix"), { timeout: 20_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    expect(github.merges()).toHaveLength(1);

    // The first task's record lists all three, each naming the task it came from.
    const origin = await detail("origin");
    const texts = origin.activityLog.map((row) => [row.from?.key ?? null, row.text]);
    expect(texts).toContainEqual([null, expect.stringContaining(`follow-up filed`)]);
    expect(texts).toContainEqual([hang, expect.stringContaining(`${fix} carries on its work`)]);
    expect(texts).toContainEqual([fix, expect.stringContaining(`merged pull request #977`)]);

    // By keys: open the record, open Activity, and open the replacement from its line.
    await expandDock(page, "now");
    await pressKey(nowRow(page, seed.origin.key), "Enter");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "origin");
    const body = recordFrame(page);
    await pressKey(body.locator('[data-record-section="timeline"] > summary'), "Enter");
    await expect(body.locator(`[data-record-from="${hang}"]`)).toBeVisible();
    const merged = body.locator(`[data-record-from="${fix}"][data-record-event="merged"]`);
    // The line's key is a link to that task, as every task key in the record is (FI3-1271).
    const key = linkedTaskKeys(merged.locator("[data-record-from-key]"));
    await focusOn(key);
    await untilFocused(key);
    // Work goes on while the captain reads: a push keeps this unchanged
    // line mounted (INF-1140), and its key keeps the keyboard (FI3-1279).
    // Observe the count's repaint separately from the key's identity: a
    // retained key alone cannot prove that the update reached the record.
    const painted = await body.locator("[data-record-activity-count]").evaluateHandle((count) => {
      const witness = { changed: false };
      const observer = new MutationObserver(() => {
        witness.changed = true;
        observer.disconnect();
      });
      observer.observe(count, { childList: true });
      return witness;
    });
    // The follow-up's view stamp sends a push without moving the keyboard.
    const drawn = await key.elementHandle();
    expect(
      await page.evaluate((taskId) => window.infinitary.tasks.opened(taskId), seed.followup.id),
    ).toEqual({ opened: true });
    await expect
      .poll(() => painted.evaluate((witness) => witness.changed), {
        message: "the push reaches the record's Activity count",
      })
      .toBe(true);
    expect(await drawn.evaluate((node) => node.isConnected)).toBe(true);
    await painted.dispose();
    await drawn.dispose();
    await untilFocused(key);
    await page.keyboard.press("Enter");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "fix");
  } finally {
    await app.close();
    await github.close();
  }
});
