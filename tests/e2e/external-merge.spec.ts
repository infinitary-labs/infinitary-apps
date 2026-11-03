import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { InboxStore } from "../../src/core/storage/inboxStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { keptRefFor } from "../../src/core/workspace/workspaceService";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp, SHORT_TICK } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { readSavedData } from "./savedData";
import { shownCard } from "./stack";

// INF-458 and the captain's safety correction: a merge is not necessarily task completion.
for (const complete of [true, false]) {
  const title = complete
    ? "a declared final external merge closes the task and preserves unpublished work"
    : "a prerequisite external merge preserves unfinished tasks, instructions and the working copy";
  test(title, async () => {
    const root = scratchDir("infinitary-external-merge-");
    const repoDir = join(root, "repo");
    const worktreeDir = join(root, "worktree");
    const taskId = "externalmerge";
    const branch = `fm/task-${taskId}`;
    const git = (...args: string[]) =>
      execFileSync("git", args, { stdio: "pipe" }).toString().trim();
    git("init", "--initial-branch=main", repoDir);
    git("-C", repoDir, "config", "user.name", "Test");
    git("-C", repoDir, "config", "user.email", "test@localhost");
    git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: start");
    git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
    writeFileSync(join(worktreeDir, "fix.txt"), "The meter now reads correctly.\n");
    git("-C", worktreeDir, "add", ".");
    git("-C", worktreeDir, "commit", "-m", "fix: correct the meter");
    const head = git("-C", worktreeDir, "rev-parse", "HEAD");
    const github = await startGitHubStub();
    github.servePull({ number: 71, title: "fix: correct the meter", headSha: head });
    seedGitHubSignIn(root);
    const db = openDatabase(root);
    seedProject(db, {
      id: "repo-hosted",
      path: repoDir,
      name: "Meter",
      setupKind: "adopt",
      origin: "https://github.com/o/hosted.git",
      runsOn: null,
      delivery: "direct-pr",
    });
    seedHostedOrigins(db, root);
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: taskId,
      title: "Correct the meter",
      status: "idle",
      repoId: "repo-hosted",
      repoDir,
      worktreeDir,
      branch,
    });
    seedDelivery(tasks, taskId, {
      prNumber: 71,
      prUrl: "https://github.com/o/hosted/pull/71",
      headSha: head,
      ci: "green",
      ciAt: 0,
      ciWatch: { head, since: 0, nextAt: 0, tries: 0 },
    });
    if (complete) {
      tasks.recordReport(taskId, {
        text: "The meter fix is complete; merging finishes this task.",
        declared: { mergeCompletesTask: { prNumber: 71, headSha: head } },
      });
    } else {
      seedTask(tasks, {
        id: "verify",
        title: "Verify deployment",
        status: "queued",
        startPolicy: "on-request",
        parentId: taskId,
        repoId: "repo-hosted",
      });
      // Delivery already exhausted its attempts; this pending instruction must
      // survive the merge, not be consumed by a newly resumed mock turn.
      const inbox = new InboxStore(db);
      const guidance = inbox.enqueue(taskId, "Verify deployment before finishing this task.");
      inbox.markEscalated(guidance);
    }
    new CardStore(db).upsert({
      id: `card-${taskId}-ready`,
      taskId,
      author: "crewmate",
      priority: 30,
      title: "The meter fix is ready",
      meta: "crewmate 1",
      body: "<p>The meter now reads correctly.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [
        {
          id: "merge",
          label: "Merge",
          default: true,
          variant: "primary",
          effect: { kind: "settle", mode: "merge" },
        },
      ],
    });
    // A plain-reply choice already made before this launch must not disable the monitor.
    const choices = new CardStore(db);
    const manualCard = `card-${taskId}-manual`;
    choices.upsert({
      id: manualCard,
      taskId,
      author: "firstmate",
      priority: 30,
      title: "Merge the meter fix on GitHub",
      meta: "first mate",
      body: "<p>The pull request is ready on GitHub.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [{ id: "myself", label: "I'll merge the PR", variant: "primary", default: true }],
    });
    choices.resolve(manualCard, "myself");
    db.close();
    // GitHub is the only stand-in; the app, saved task, inbox and git cleanup are real.
    // A draft edit remains unmerged and must be kept, not silently discarded.
    writeFileSync(join(worktreeDir, "draft.txt"), "Keep this unpublished draft.\n");
    github.mergeByHand(71);
    const app = await launchApp({
      userDataDir: root,
      withMockProvider: true,
      env: { ...github.env, ...SHORT_TICK },
    });
    try {
      if (!complete) {
        await expect
          .poll(() => app.page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
          .toMatchObject({ status: "active", delivery: { ci: "merged" } });
        const saved = readSavedData(root, (db) => ({
          task: db
            .prepare("SELECT status, closed_reason, workspace_state FROM tasks WHERE id = ?")
            .get(taskId),
          child: db.prepare("SELECT status FROM tasks WHERE id = 'verify'").get(),
          instructions: db.prepare("SELECT payload FROM inbox WHERE recipient = ?").all(taskId),
        }));
        expect(saved.task).toMatchObject({
          status: "active",
          closed_reason: null,
          workspace_state: "present",
        });
        expect(saved.child).toMatchObject({ status: "open" });
        expect(JSON.stringify(saved.instructions)).toContain(
          "Verify deployment before finishing this task.",
        );
        expect(existsSync(worktreeDir)).toBe(true);
        expect(git("-C", worktreeDir, "status", "--porcelain")).toContain("draft.txt");
        await expect(shownCard(app.page, "The meter fix is ready")).toHaveCount(1);
        expect(github.requests().filter((line) => !line.startsWith("GET "))).toEqual([]);
        console.log("Unfinished task after external merge", {
          ...saved,
          copyPresent: existsSync(worktreeDir),
          requests: github.requests(),
        });
        return;
      }
      await expect
        .poll(() => app.page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
        .toMatchObject({ status: "done", closedReason: "merged" });
      await expect.poll(() => existsSync(worktreeDir)).toBe(false);
      // The directory is renamed away before retirement marks the saved row.
      // Wait on that owner's completion signal, not just on filesystem absence.
      const saved = () =>
        readSavedData(root, (db) =>
          db
            .prepare("SELECT status, closed_reason, workspace_state FROM tasks WHERE id = ?")
            .get(taskId),
        );
      await expect.poll(saved).toMatchObject({
        status: "done",
        closed_reason: "merged",
        workspace_state: "removed",
      });
      console.log("External merge result", {
        task: saved(),
        copyPresent: existsSync(worktreeDir),
        requests: github.requests(),
      });
      expect(git("-C", repoDir, "show", `${keptRefFor(taskId)}:draft.txt`)).toBe(
        "Keep this unpublished draft.",
      );
      expect(github.requests().filter((line) => !line.startsWith("GET "))).toEqual([]);
      await expect(shownCard(app.page, "The meter fix is ready")).toHaveCount(0);
    } finally {
      await app.close();
      await github.close();
    }
  });
}
