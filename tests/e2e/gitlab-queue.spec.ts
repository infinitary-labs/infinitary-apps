import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { QUEUE_STATUS, QUEUE_WAITING_WORDS } from "../../src/core/forge/forge";
import { QUEUE_TOKEN_NAME } from "../../src/core/forge/providers/gitlab/queue";
import { CHECK_WATCH_FAST_MS } from "../../src/core/orchestrator/checkWatch";
import { GITLAB_QUEUE_PART, shippedFiles } from "../../src/core/queue/shipped";
import { named, QUEUE_ENVIRONMENT, TOKEN_VARIABLE } from "../../src/core/queue/shipped/gitlab.mjs";
import {
  PAUSE_LABEL,
  pauseIssue,
  pauseWrites,
  verdict,
} from "../../src/core/queue/shipped/rules.mjs";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  QUEUE_KEY_WORDS,
  QUEUE_PAUSE_WORDS,
  QUEUE_SHIPPED_WORDS,
} from "../../src/renderer/src/settings/projectsWords";
import { MERGE_WORDS, PROJECT_DELIVERY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { GITLAB_STUB_PROJECT, seedGitLabSignIn, startGitLabStub } from "./gitlabStub";
import { launchApp, SHORT_TICK } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { projectRow } from "./projects";
import { showCard } from "./stack";
import { focusOn, pressKey, typeInto } from "./windowKeys";

/**
 * The shipped queue on GitLab (docs/forge.md, "The shipped queue on
 * GitLab"), on gitlab.com and on a self-hosted server: the project's default
 * branch carries the queue's files, read from their one source, and its CI
 * file includes the queue.
 *
 * The app reads the stamp at start and batches the project, fixed in
 * Settings. The captain makes the queue's key there with one press: a
 * project access token kept as a masked, protected CI variable only the
 * queue's environment receives, never shown. The merge click on a merge
 * request's card writes the waiting mark as a finished status, since GitLab
 * refuses a waiting status twice, starts the queue's pipeline on the
 * default branch and merges nothing. The queue then pauses the batch it
 * formed with a teammate's change behind one issue; the app's own reading
 * of the merge request finds it and Settings names the changes as GitLab
 * does, `!1`. The captain resumes by keys with a reason: the app writes the
 * waiting mark back, closes the issue with the reason and starts the queue,
 * and the pause ends.
 *
 * Regression: Resume's confirmation and the fast sweep used to race. Hold
 * only the host's post-close issue-list response until the confirmation is
 * observed, then let that same sweep end the pause. Both facts remain
 * required, independent of the polling interval or the computer's speed.
 *
 * GitLab is a local stand-in (`./gitlabStub.ts`) the app reaches through
 * its real key sign-in and its real GitLab forge. Requires desktop Electron
 * and local git; no real account is asked.
 */

const HOSTS = ["gitlab.com", "gitlab.example.com"] as const;

/** The shipped queue's one source, which a project's files are generated from. */
const SHIPPED_SOURCE_DIR = fileURLToPath(new URL("../../src/core/queue/shipped/", import.meta.url));

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

for (const host of HOSTS) {
  test(`a GitLab project on ${host} running the shipped queue makes its key in one press, queues a merge, and resumes its paused batch by keys`, async () => {
    // The app reads the change again when its check watch does, one watch
    // interval after the merge click, so the journey outlasts it.
    test.setTimeout(3 * 60_000);
    const userDataDir = scratchDir("infinitary-gitlab-queue-");
    const taskId = "notesqueue";
    const repoDir = join(userDataDir, "repo");
    const worktreeDir = join(userDataDir, "worktree");
    const branch = `fm/task-${taskId}`;
    git("init", "--initial-branch=main", repoDir);
    git("-C", repoDir, "config", "user.name", "Test");
    git("-C", repoDir, "config", "user.email", "test@localhost");
    git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: seed the notes");
    git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
    // e2e-fixture: input -- Author the real project file this journey batches.
    writeFileSync(join(worktreeDir, "sync.txt"), "The notes sync on time.\n");
    git("-C", worktreeDir, "add", "sync.txt");
    git("-C", worktreeDir, "commit", "-m", "fix: sync the notes on time");
    const headSha = git("-C", worktreeDir, "rev-parse", "HEAD");

    const gitlab = await startGitLabStub(host);
    const queueFiles = Object.fromEntries(
      shippedFiles(SHIPPED_SOURCE_DIR, GITLAB_QUEUE_PART).map((file) => [file.path, file.text]),
    );
    gitlab.serveFiles({
      ...queueFiles,
      ".gitlab-ci.yml": `include:\n  - local: ${GITLAB_QUEUE_PART.queueFile}\n\ntest:\n  script: npm test\n`,
    });
    gitlab.headOf((name) => git("-C", repoDir, "rev-parse", `refs/heads/${name}`));
    const iid = gitlab.openMergeRequest({ branch, title: "fix: sync the notes on time" });
    seedGitLabSignIn(userDataDir, host);
    const origin = `https://${host}/${GITLAB_STUB_PROJECT}.git`;
    const db = openDatabase(userDataDir);
    seedProject(db, {
      id: "repo-notes",
      path: repoDir,
      name: "field-notes",
      setupKind: "clone",
      origin,
      runsOn: null,
      delivery: "direct-pr",
      rigor: "quick",
      addedAt: 1,
    });
    seedHostedOrigins(db, userDataDir);
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: taskId,
      title: "Sync the notes on time",
      status: "idle",
      repoId: "repo-notes",
      repoDir,
      worktreeDir,
      branch,
    });
    const cardId = `card-${taskId}-1`;
    const offerId = "offer-gitlab-queue";
    seedDelivery(tasks, taskId, {
      mode: "direct-pr",
      prNumber: iid,
      prUrl: `https://${host}/${GITLAB_STUB_PROJECT}/-/merge_requests/${iid}`,
      changeLabel: `!${iid}`,
      headSha,
      ci: "green",
      ciAt: Date.now(),
      completionOffers: [{ cardId, offerId, headSha, prNumber: iid, at: Date.now() }],
    });
    new CardStore(db).upsert({
      id: cardId,
      lifecycleId: "lifecycle-gitlab-queue",
      offerId,
      taskId,
      author: "crewmate",
      priority: 30,
      title: "The notes sync on time",
      meta: "crewmate 1",
      body: "<p>The fix is ready.</p><p>It changes one file.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [
        {
          id: "merge",
          label: MERGE_WORDS["merge-pr"],
          variant: "primary",
          default: true,
          effect: { kind: "merge", after: "close" },
        },
      ],
    });
    db.close();

    const launched = await launchApp({
      userDataDir,
      env: { ...gitlab.env, ...SHORT_TICK },
      withMockProvider: true,
    });
    try {
      const { page } = launched;
      const notes = async () =>
        (await page.evaluate(() => window.infinitary.repos.list())).find(
          (repo) => repo.id === "repo-notes",
        );
      // The app read the project's queue at start: it is batched here too.
      await expect.poll(notes, { timeout: 20_000 }).toMatchObject({ delivery: "queue-pr" });

      // The merge click writes the waiting mark as a finished status, starts
      // the queue's pipeline on the default branch, and merges nothing.
      await showCard(page, "The notes sync on time");
      await pressKey(
        page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }),
        "Enter",
      );
      await expect
        .poll(() => gitlab.statuses(headSha), { timeout: 20_000 })
        .toEqual([
          expect.objectContaining({
            name: QUEUE_STATUS,
            status: "skipped",
            description: QUEUE_WAITING_WORDS,
          }),
        ]);
      await expect.poll(() => gitlab.pipelineStarts()).toEqual([{ ref: "main" }]);
      expect(gitlab.merges()).toEqual([]);

      // The queue batches it with a teammate's change, !14, and the batch
      // fails: the queue's own verdict names the pause, its issue and the
      // paused status it writes on each change, with GitLab's names.
      const runUrl = `https://${host}/${GITLAB_STUB_PROJECT}/-/pipelines/4410`;
      const members = [
        { number: iid, head: headSha },
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
        failed: [{ name: "infinitary-queue-checks / unit", url: runUrl }],
      });
      if (!pause) throw new Error("A red batch pauses.");
      const issue = pauseIssue(pause, runUrl);
      gitlab.servePauseIssue({ iid: 88, description: issue.body, labels: [PAUSE_LABEL] });
      const [paused] = pauseWrites(pause, `https://${host}/${GITLAB_STUB_PROJECT}/-/issues/88`);
      gitlab.setStatus(headSha, {
        name: QUEUE_STATUS,
        status: "skipped",
        description: named(paused?.description ?? ""),
      });

      // The app's own reading of the merge request finds the pause and keeps
      // it: the check watch reads it at its first interval after the click.
      await expect.poll(notes, { timeout: CHECK_WATCH_FAST_MS * 2 }).toMatchObject({
        queuePause: {
          run: 4410,
          changes: [iid, 14],
          url: `https://${host}/${GITLAB_STUB_PROJECT}/-/issues/88`,
        },
      });
      expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual([]);

      await pressKey(page.getByRole("button", { name: "Settings" }), "Enter");
      await pressKey(page.getByRole("tab", { name: "Projects" }), "Enter");
      const row = projectRow(page, "repo-notes");
      await pressKey(row.getByRole("button", { expanded: false }), "Enter");
      const choices = row.getByRole("radiogroup", { name: "Where changes go" });
      const queue = choices.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["queue-pr"] });
      await expect(queue).toBeChecked();
      await expect(queue).toBeDisabled();
      await expect(row.getByText(QUEUE_SHIPPED_WORDS.set(GITLAB_QUEUE_PART.version))).toBeVisible();

      // The queue's key: missing until one press makes it with the
      // captain's sign-in, kept where only the queue's jobs receive it.
      const key = row.getByRole("region", { name: QUEUE_KEY_WORDS.title });
      await expect(key).toHaveAttribute("data-queue-key", "missing");
      await pressKey(key.getByRole("button", { name: QUEUE_KEY_WORDS.make }), "Enter");
      await expect(key.getByText(QUEUE_KEY_WORDS.made)).toBeVisible();
      await expect(key).toHaveAttribute("data-queue-key", "ready");
      expect(gitlab.tokens()).toEqual([
        expect.objectContaining({
          name: QUEUE_TOKEN_NAME,
          scopes: ["api"],
          access_level: 40,
          active: true,
        }),
      ]);
      const [token] = gitlab.tokens();
      expect(gitlab.variable(TOKEN_VARIABLE)).toMatchObject({
        value: `glpat-queue-${token?.id}`,
        masked: true,
        protected: true,
        raw: true,
        environment_scope: QUEUE_ENVIRONMENT,
      });
      await expect(key).not.toContainText("glpat-");

      // The paused batch names each change as GitLab does.
      const panel = row.getByRole("region", { name: QUEUE_PAUSE_WORDS.title });
      await expect(panel).toContainText(`!${iid}, !14`);
      await expect(panel.getByText(QUEUE_PAUSE_WORDS.unclaimed)).toBeVisible();

      // Resume needs a reason, and goes out once with it.
      const resume = panel.getByRole("button", { name: QUEUE_PAUSE_WORDS.resume });
      const reason = "The failed test is flaky and its owner has a task";
      const field = panel.getByRole("textbox", { name: QUEUE_PAUSE_WORDS.reason });
      await focusOn(field);
      await typeInto(field, reason);
      const refresh = gitlab.holdClosedPauseReads();
      let confirmation: string;
      try {
        await pressKey(resume, "Enter");
        // Require the competing sweep to arrive before reading the message.
        // It cannot remove the panel until the host answers that read.
        await expect.poll(refresh.waiting).toBe(true);
        await expect(panel.getByText(QUEUE_PAUSE_WORDS.sent)).toBeVisible();
        confirmation = await panel.getByText(QUEUE_PAUSE_WORDS.sent).innerText();
        // The app answered with the captain's sign-in: the change waits again,
        // the issue closed with the reason, and the queue started.
        expect(gitlab.statuses(headSha).at(-1)).toMatchObject({
          name: QUEUE_STATUS,
          status: "skipped",
          description: QUEUE_WAITING_WORDS,
        });
        expect(gitlab.pauseIssue()).toMatchObject({
          state: "closed",
          notes: [expect.stringContaining(reason)],
        });
        expect(gitlab.pipelineStarts()).toEqual([{ ref: "main" }, { ref: "main" }]);
      } finally {
        refresh.release();
      }

      // The already-arrived pass now reads the closed issue and ends the pause.
      await expect(panel).toHaveCount(0, { timeout: 30_000 });
      const after = await notes();
      expect(after?.queuePause).toBeUndefined();
      expect(gitlab.merges()).toEqual([]);
      await test.info().attach("resume-and-refresh", {
        contentType: "application/json",
        body: JSON.stringify({
          host,
          confirmation,
          issue: gitlab.pauseIssue(),
          status: gitlab.statuses(headSha).at(-1),
          pipelines: gitlab.pipelineStarts(),
          panelCount: await panel.count(),
          pause: after?.queuePause ?? null,
          merges: gitlab.merges(),
        }),
      });
    } finally {
      await launched.close();
      await gitlab.close();
    }
  });
}
