import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { presentationCommitMessage, presentationRegionMarkers } from "../../src/core/forge";
import { presentationMarkdownText } from "../../src/core/forge/presentation";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskDetail } from "../../src/shared/tasks";
import { CHECK_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { API_WRITE_GUARD_MARKER, mergeWriteCases, savedWriteAsks } from "./apiWriteCases";
import { cardBody } from "./frames";
import {
  GITLAB_STUB_OTHER_PROJECT,
  GITLAB_STUB_PROJECT,
  type GitLabStub,
  seedGitLabSignIn,
  startGitLabStub,
} from "./gitlabStub";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { GITLAB_EVIDENCE_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { expandDock, notesNaming, putInLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import {
  GITHUB_CHANGE_PROMPT_MARKER,
  githubChange,
  MOCK_GITHUB_CHANGE,
  MOCK_GITHUB_CHANGE_CARD_TITLE,
  MOCK_GITHUB_LEGACY_CHANGE_CARD_TITLE,
} from "./scenarios/githubChange";
import { factsStrip, shownCard } from "./stack";

/**
 * GitLab delivery (`docs/forge.md`, "GitLab merge requests"), the way a
 * person meets it on gitlab.com and on a self-hosted server: a crewmate
 * pushes its branch and opens a merge request with its own tools, the
 * pipeline GitLab ran reads as the card's checks, and the captain's click
 * squash-merges exactly the version the checks read - while a head that
 * moved, a conflict, a failed pipeline, a running job, a manual job nobody
 * started and a failed merged-results pipeline each stop the click with
 * nothing merged.
 *
 * On gitlab.com the merge request and its completion card tell one saved
 * story (INF-132): the description is the story's generated region and the
 * squash carries its plain summary; a self-hosted server keeps the body the
 * crewmate wrote.
 *
 * A crewmate diagnosing a failed pipeline there lists the version's
 * pipelines and jobs with its API tool, reads the failed job's log and
 * saves its artifacts archive with its evidence tools, and cannot write to
 * any project but its own.
 *
 * GitLab is a local stand-in (`./gitlabStub.ts`) the app reaches through
 * its real key sign-in, its real GitLab forge and its real git; every push
 * goes to a bare repository on this Mac through git's own `insteadOf`, so
 * the project's recorded address is a real GitLab address in a nested
 * group. No real account is asked.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

const HOSTS = ["gitlab.com", "gitlab.example.com"] as const;

const originOn = (host: string) => `https://${host}/${GITLAB_STUB_PROJECT}.git`;

/** A direct-pr project on the host whose origin, through git's `insteadOf`, is a bare repository here. */
function seedProject(userDataDir: string, host: string) {
  const bare = join(userDataDir, "gitlab-field-notes.git");
  git("init", "--bare", "--initial-branch=main", bare);
  const dir = join(userDataDir, "field-notes");
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "chore: seed the notes");
  git("-C", dir, "remote", "add", "origin", originOn(host));
  git("-C", dir, "config", `url.${bare}.insteadOf`, originOn(host));
  git("-C", dir, "push", "origin", "HEAD:refs/heads/main");
  git("-C", dir, "fetch", "origin");
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'quick')",
  ).run("repo-notes", dir, "field-notes", 1, originOn(host));
  seedHostedOrigins(db, userDataDir);
  db.close();
  return { bare, dir };
}

/** The pushed version of a branch where the project lives. */
const headIn = (bare: string) => (branch: string) =>
  git("-C", bare, "rev-parse", `refs/heads/${branch}`);

async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

for (const host of HOSTS) {
  test(`a crewmate cannot merge or move the default branch through raw writes on ${host}`, async () => {
    const userDataDir = scratchDir("infinitary-gitlab-guard-");
    const { bare } = seedProject(userDataDir, host);
    git("-C", bare, "branch", "topic", "main");
    seedGitLabSignIn(userDataDir, host);
    const gitlab = await startGitLabStub(host);
    const launched = await launchApp({ withMockProvider: true, userDataDir, env: gitlab.env });
    try {
      const title = `field-notes guard-gitlab ${API_WRITE_GUARD_MARKER}`;
      await send(launched.page, `${SPAWN_PROMPT_MARKER} ${title}`);
      let id = "";
      await expect
        .poll(
          async () => {
            const task = (
              await launched.page.evaluate(() => window.infinitary.tasks.board())
            ).tasks.find((row) => row.title === title);
            id = task?.id ?? "";
            return task?.activity;
          },
          { timeout: 45_000 },
        )
        .toBe("idle");
      const detail = await launched.page.evaluate(
        (taskId) => window.infinitary.tasks.detail(taskId),
        id,
      );
      const outcome = detail?.outcome ?? "";
      const calls = mergeWriteCases(
        "gitlab",
        `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`,
      );
      expect(outcome.split("(refused)").length - 1).toBe(calls.length);
      expect(outcome).toContain("request_merge");
      expect(
        gitlab
          .requests()
          .filter((request) => /^(POST|PUT|PATCH|DELETE) \/api\/v4\/projects\//.test(request)),
      ).toEqual([
        `DELETE /api/v4/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}/repository/branches/topic`,
      ]);
      expect(outcome).toContain('"status": 204');
      expect(gitlab.merges()).toEqual([]);
      const transcript = `${outcome}\n\nRequests:\n${gitlab.requests().join("\n")}`;
      await test.info().attach("merge-api-guard", { body: transcript, contentType: "text/plain" });
      if (process.env.INFINITARY_TASK_EVIDENCE_DIR)
        writeFileSync(
          join(process.env.INFINITARY_TASK_EVIDENCE_DIR, `${host}-merge-api-guard.txt`),
          transcript,
        );
    } finally {
      await launched.close();
      await gitlab.close();
    }
  });

  test(`a crewmate opens a merge request on ${host}, its pipeline reads as the checks, and the captain's click squash-merges that version`, async () => {
    const userDataDir = scratchDir("infinitary-gitlab-delivery-");
    const { bare } = seedProject(userDataDir, host);
    seedGitLabSignIn(userDataDir, host);
    const gitlab = await startGitLabStub(host);
    gitlab.headOf(headIn(bare));
    const launched = await launchApp({
      withMockProvider: true,
      scenarios: [githubChange],
      userDataDir,
      env: gitlab.env,
    });
    const pictures = process.env.INFINITARY_GITLAB_PICTURES;
    try {
      const { page } = launched;
      await resizeWindow(launched.app, page, { width: 1280, height: 800 });
      // The project is GitLab's, with the key sign-in on file.
      await expect
        .poll(async () => (await page.evaluate(() => window.infinitary.repos.list()))[0]?.host)
        .toEqual({ kind: "gitlab", name: host });
      const title = `field-notes ${GITHUB_CHANGE_PROMPT_MARKER}`;
      await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);

      // The completion card cleared the checks gate on GitLab's pipeline.
      const savedStory = host === "gitlab.com";
      const cardTitle = savedStory
        ? MOCK_GITHUB_CHANGE_CARD_TITLE
        : MOCK_GITHUB_LEGACY_CHANGE_CARD_TITLE;
      const card = shownCard(page, cardTitle);
      await expect(card).toBeVisible({ timeout: 45_000 });
      const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (row) => row.title === title,
      );
      if (!task) throw new Error("The crewmate's task is missing");
      const sentUp = headIn(bare)(`fm/task-${task.id}`);
      const project = encodeURIComponent(GITLAB_STUB_PROJECT);
      expect(gitlab.requests()).toContain(`POST /api/v4/projects/${project}/merge_requests`);
      expect(gitlab.requests()).toContain(`GET /api/v4/projects/${project}/pipelines/101/jobs`);
      const webUrl = `https://${host}/${GITLAB_STUB_PROJECT}/-/merge_requests/1`;
      const facts = factsStrip(cardBody(page, cardTitle));
      await expect(facts.change.locator(`a[href="${webUrl}"]`)).toHaveText("!1");
      await expect(facts.checks).toHaveText(CHECK_WORDS.green);
      expect(
        await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id),
      ).toMatchObject({
        delivery: { changeLabel: "!1", prNumber: 1, prUrl: webUrl, ci: "green", headSha: sentUp },
      });
      if (pictures) {
        await regionShot(card, join(pictures, `${host}-completion-card-after.png`));
        await regionShot(
          card.locator("[data-card-facts]"),
          join(pictures, `${host}-completion-facts-after.png`),
        );
        if (host === "gitlab.com") {
          await heroShot(page, { region: card, name: "gitlab-merge-requests" });
        }
      }

      // gitlab.com's merge request carries the saved story's generated region;
      // a server's own host keeps the description the crewmate gave.
      const description = gitlab.descriptions().get(1) ?? "";
      if (savedStory) {
        const { start, end } = presentationRegionMarkers(task.id);
        expect(description.startsWith(start)).toBe(true);
        expect(description.endsWith(end)).toBe(true);
        expect(description).toContain("## Why");
        expect(description).toContain(presentationMarkdownText(MOCK_GITHUB_STORY.noPicture ?? ""));
      } else {
        expect(description).toBe(MOCK_GITHUB_CHANGE.body);
      }
      if (pictures)
        writeFileSync(join(pictures, `${host}-merge-request-description.md`), description);

      // The captain's click: one squash of that merge request at the version
      // the crewmate pushed, under its title and the story's plain summary
      // (INF-228 F2), or the description it gave on a server's own host.
      await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
      await expect(putInLine(page, task.key)).toBeVisible({ timeout: 30_000 });
      expect(gitlab.merges()).toEqual([
        {
          iid: 1,
          sha: sentUp,
          squash: true,
          message: `${MOCK_GITHUB_CHANGE.title}\n\n${
            savedStory ? presentationCommitMessage(MOCK_GITHUB_STORY) : MOCK_GITHUB_CHANGE.body
          }`,
        },
      ]);
      await expect
        .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), task.id))
        .toMatchObject({ status: "done", closedReason: "merged" });
    } finally {
      await launched.close();
      await gitlab.close();
    }
  });
}

/** A failed job's log as GitLab keeps it: colour codes and its own section markers. */
const FAILED_TRACE = [
  "\u001b[0Ksection_start:1760000000:step_script\r\u001b[0K\u001b[0K\u001b[36;1mExecuting step_script\u001b[0;m",
  "\u001b[32;1m$ pnpm measure\u001b[0;m",
  "Measure pairs: exit 1",
  "\u001b[31;1mMissing measurement input\u001b[0;m",
  "section_end:1760000009:step_script\r\u001b[0K",
].join("\n");

for (const host of HOSTS) {
  test(`a crewmate on ${host} reads a failed job's log, saves its artifacts archive, and writes only to its own project`, async ({
    browserName: _browserName,
  }, testInfo) => {
    const userDataDir = scratchDir("infinitary-gitlab-evidence-");
    const { bare } = seedProject(userDataDir, host);
    seedGitLabSignIn(userDataDir, host);
    const gitlab = await startGitLabStub(host);
    // GitLab ran a pipeline for the project's version, whose measurement job
    // failed and kept its archive.
    const main = git("-C", bare, "rev-parse", "refs/heads/main");
    gitlab.headOf(() => main);
    gitlab.openMergeRequest({ branch: "measure-notes", title: "test: measure the notes" });
    gitlab.setPipelines([
      {
        status: "failed",
        jobs: [
          { name: "lint", status: "success" },
          {
            name: "measure",
            status: "failed",
            trace: FAILED_TRACE,
            artifacts: { zip: readFileSync("tests/fixtures/forge/measurement.zip") },
          },
        ],
      },
    ]);
    const launched = await launchApp({ withMockProvider: true, userDataDir, env: gitlab.env });
    try {
      const { page } = launched;
      const title = `field-notes ${GITLAB_EVIDENCE_MARKER}`;
      await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
      let id = "";
      await expect
        .poll(
          async () => {
            const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
              (row) => row.title === title,
            );
            id = task?.id ?? "";
            return task?.activity;
          },
          { timeout: 45_000 },
        )
        .toBe("idle");
      const outcome =
        (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id))?.outcome ??
        "";
      // The version's pipeline, the failed job's own words, and the archive's contents.
      expect(outcome).toContain(main);
      expect(outcome).toContain("Missing measurement input");
      expect(outcome).not.toMatch(/\\u001b|section_start/);
      expect(outcome).toContain('"controlSeconds":88.41,"candidateSeconds":86.41,"pairs":5');
      // A write to another project is kept for the captain's click and never reached GitLab.
      const asks = savedWriteAsks(userDataDir, id);
      expect(asks).toEqual([
        expect.objectContaining({
          kind: "gitlab",
          method: "POST",
          path: `/projects/${encodeURIComponent(GITLAB_STUB_OTHER_PROJECT)}/issues`,
        }),
      ]);
      expect(asks[0]?.sentAt).toBeUndefined();
      expect(outcome).not.toMatch(/glpat-|signed=/);
      const row = readSavedData(
        userDataDir,
        (db) =>
          db.prepare("SELECT worktree_dir AS cwd FROM tasks WHERE id = ?").get(id) as {
            cwd: string;
          },
      );
      const archive = join(row.cwd, ".infinitary-artifacts/run-101/artifact-101001.zip");
      expect(readFileSync(archive)).toEqual(readFileSync("tests/fixtures/forge/measurement.zip"));
      expect(statSync(archive).mode & 0o777).toBe(0o600);
      const project = `/api/v4/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`;
      expect(gitlab.requests()).toEqual(
        expect.arrayContaining([
          `GET ${project}/pipelines`,
          `GET ${project}/pipelines/101/jobs`,
          `GET ${project}/pipelines/101`,
          `GET ${project}/jobs/101001`,
          `GET ${project}/jobs/101001/trace`,
          `GET ${project}/jobs/101001/artifacts`,
          "GET /storage/job-artifacts/101001.zip",
        ]),
      );
      expect(
        gitlab
          .requests()
          .some((request) => request.includes(encodeURIComponent(GITLAB_STUB_OTHER_PROJECT))),
      ).toBe(false);
      await testInfo.attach("gitlab-evidence-transcript", {
        body: `${outcome}\n\nRequests:\n${gitlab.requests().join("\n")}`,
        contentType: "text/plain",
      });
      const evidence = process.env.INFINITARY_GITLAB_PICTURES;
      if (evidence) {
        writeFileSync(
          join(evidence, `${host}-crewmate-evidence.txt`),
          `${outcome}\n\nRequests:\n${gitlab.requests().join("\n")}\n`,
        );
      }
    } finally {
      await launched.close();
      await gitlab.close();
    }
  });
}

/** What the task's record says stopped a merge: its notes' problems, and its checks. */
function stopOf(task: TaskDetail | null): { problem: string; ci: string | undefined } {
  const notes = (task?.events ?? []).filter((event) => event.kind === "note");
  return {
    problem: notes.map((event) => String(event.data?.problem ?? "")).join("\n"),
    ci: task?.delivery?.ci,
  };
}

/** A merge request someone opened for the task's branch, whose completion card is up. */
const CHANGE = { title: "feat: field notes sync", description: "The notes sync on time." };
const READY_CARD_TITLE = "The merge request is ready";

type Repo = { dir: string; branch: string; push: (subject: string) => void };

/**
 * Changes that must not go in, each one fact away from the journey above
 * (which does): what is wrong where the project lives, whether the app gets
 * as far as asking GitLab to merge, and the fact the task's record keeps
 * about why it stopped - read off the spec's own inputs, never the words.
 */
const REFUSALS: {
  change: string;
  arrange: (gitlab: GitLabStub, repo: Repo) => string;
  asksGitLab: boolean;
  stoppedBy: (stop: ReturnType<typeof stopOf>, fact: string) => boolean;
}[] = [
  {
    change: "a head that moved on between the check and the merge",
    arrange: (gitlab, repo) => {
      gitlab.onMergeRequest(() => repo.push("feat: one more note"));
      return "answered 409";
    },
    asksGitLab: true,
    stoppedBy: (stop, answer) => stop.problem.includes(answer),
  },
  {
    change: "a conflict with newer work on main",
    arrange: (gitlab) => {
      gitlab.conflicts(() => true);
      return "Branch cannot be merged";
    },
    asksGitLab: true,
    stoppedBy: (stop, answer) => stop.problem.includes(answer),
  },
  {
    change: "a failed pipeline",
    arrange: (gitlab) => {
      gitlab.setPipelines([{ status: "failed", jobs: [{ name: "test", status: "failed" }] }]);
      return "red";
    },
    asksGitLab: false,
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
  {
    change: "a job still running",
    arrange: (gitlab) => {
      gitlab.setPipelines([
        {
          status: "running",
          jobs: [
            { name: "lint", status: "success" },
            { name: "test", status: "running" },
          ],
        },
      ]);
      return "pending";
    },
    asksGitLab: false,
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
  {
    change: "a manual job nobody started",
    arrange: (gitlab) => {
      gitlab.setPipelines([
        {
          status: "manual",
          jobs: [
            { name: "test", status: "success" },
            { name: "approve", status: "manual" },
          ],
        },
      ]);
      return "pending";
    },
    asksGitLab: false,
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
  {
    change: "a failed merged-results pipeline beside a passing branch pipeline",
    arrange: (gitlab) => {
      gitlab.setPipelines([
        { status: "success" },
        { kind: "merge", status: "failed", jobs: [{ name: "test", status: "failed" }] },
      ]);
      return "red";
    },
    asksGitLab: false,
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
];

for (const host of HOSTS) {
  for (const refusal of REFUSALS) {
    test(`a merge on ${host} with ${refusal.change} merges nothing and leaves the task open`, async () => {
      const userDataDir = scratchDir("infinitary-gitlab-refused-");
      const taskId = "notestask";
      const repoDir = join(userDataDir, "repo");
      const worktreeDir = join(userDataDir, "worktree");
      const branch = `fm/task-${taskId}`;
      git("init", "--initial-branch=main", repoDir);
      git("-C", repoDir, "config", "user.name", "Test");
      git("-C", repoDir, "config", "user.email", "test@localhost");
      git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: seed the notes");
      git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
      writeFileSync(join(worktreeDir, "sync.txt"), "The notes sync on time.\n");
      git("-C", worktreeDir, "add", "sync.txt");
      git("-C", worktreeDir, "commit", "-m", CHANGE.title);
      const repo: Repo = {
        dir: repoDir,
        branch,
        push: (subject) => git("-C", worktreeDir, "commit", "--allow-empty", "-m", subject),
      };
      const gitlab = await startGitLabStub(host);
      gitlab.headOf((name) => git("-C", repoDir, "rev-parse", `refs/heads/${name}`));
      gitlab.openMergeRequest({ branch, ...CHANGE });
      const fact = refusal.arrange(gitlab, repo);
      seedGitLabSignIn(userDataDir, host);
      const db = openDatabase(userDataDir);
      db.prepare(
        "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
      ).run("repo-notes", repoDir, "field-notes", Date.now(), originOn(host));
      seedHostedOrigins(db, userDataDir);
      seedTask(new TaskService({ db, strict: true }), {
        id: taskId,
        title: "Sync the notes",
        status: "idle",
        repoId: "repo-notes",
        repoDir,
        worktreeDir,
        branch,
      });
      new CardStore(db).upsert({
        id: `card-${taskId}-1`,
        taskId,
        author: "crewmate",
        priority: 30,
        title: READY_CARD_TITLE,
        meta: "crewmate 1",
        body: "<p>The notes sync on time; the pipeline passed.</p>",
        status: "ready",
        createdAt: Date.now(),
        actions: [
          {
            id: "merge",
            label: MERGE_WORDS["merge-pr"],
            variant: "primary",
            default: true,
            effect: { kind: "settle", mode: "merge" },
          },
        ],
      });
      db.close();

      const launched = await launchApp({ userDataDir, env: gitlab.env });
      try {
        const { page } = launched;
        await expect(shownCard(page, READY_CARD_TITLE)).toBeVisible();
        await expandDock(page, "activity");
        await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
        await expect(notesNaming(page, "Sync the notes").first()).toBeVisible();
        const detail = () => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
        await expect
          .poll(async () => refusal.stoppedBy(stopOf(await detail()), fact), { timeout: 20_000 })
          .toBe(true);
        // Nothing went in: GitLab merged nothing (and was asked only when the
        // head or main moved under it), and the task is still open with its
        // work on its branch.
        expect(gitlab.merges()).toEqual([]);
        expect(gitlab.requests().filter((request) => request.endsWith("/merge"))).toHaveLength(
          refusal.asksGitLab ? 1 : 0,
        );
        await expect(notesNaming(page, "Sync the notes")).toHaveCount(2);
        await expect(putInLine(page, await taskKey(page, "Sync the notes"))).toHaveCount(0);
        expect(await detail()).toMatchObject({ status: "active", closedReason: null });
        expect(existsSync(join(worktreeDir, "sync.txt"))).toBe(true);
      } finally {
        await launched.close();
        await gitlab.close();
      }
    });
  }
}
