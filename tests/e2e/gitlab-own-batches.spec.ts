import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { batchTitle } from "../../src/core/batches/batches";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { BATCH_HOLD_WORDS, BATCH_OWN_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { BATCH_BRANCH_PREFIX } from "../../src/shared/batches";
import { changeNumberLabel } from "../../src/shared/forge";
import { BUNDLED_NAMING } from "../helpers/namingRunbook";
import { scratchDir } from "../helpers/scratchDirs";
import { GITLAB_STUB_PROJECT, seedGitLabSignIn, startGitLabStub } from "./gitlabStub";
import { launchApp, SHORT_TICK } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { projectLine, projectSettings } from "./projects";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  ownBatch,
  ownBatchChanged,
  ownBatchPrompt,
  ownBatchTask,
  ownBatchTitle,
} from "./scenarios/ownBatch";
import { completionAction, showCard } from "./stack";
import { pressKey } from "./windowKeys";

const HOST = "gitlab.com";
/** A merge request's pipeline, by the merge request's number. */
const running = (iid: number) => ({
  iid,
  status: "running",
  jobs: [{ name: "unit-tests", status: "running" }],
});
const passed = (iid: number) => ({
  iid,
  status: "success",
  jobs: [{ name: "unit-tests", status: "success" }],
});

/**
 * INF-3759 piece 1, the captain's approved plan for batches of their own
 * "on GitHub (incl. Enterprise) and GitLab": on GitLab the batch is one
 * merge request, "A batch of one reads and merges exactly as that change's
 * pull request does today" (a squash under the change's title), and a
 * batch of several merges without squash so main keeps "one commit per
 * change". A batch whose pipeline failed holds, and Try again in Settings,
 * by keys, combines it again on the same merge request.
 *
 * Real git supplies three crewmates' commits and the app's own combine and
 * push; a disposable GitLab serves a project on batched pull requests,
 * a passed pipeline on each pushed branch, the merge requests the app
 * opens and their pipelines, and records each merge, writing it to the
 * project's default branch as GitLab does: a squash commit, or a merge
 * commit over the batch's commits. The crewmates' moves are scripted
 * (`scenarios/ownBatch.ts`). One journey: its sections share the project
 * and each needs the batch before it. Completion signals are GitLab's own
 * records: the merge requests opened, the merges accepted, the default
 * branch's commits and each task's close. Requires desktop Electron and
 * local git; no real sign-in or shared merge request.
 */
test("approved changes of a GitLab project merge in batches of the captain's own: one squashed, two kept as their own commits after Try again by keys", async () => {
  test.setTimeout(5 * 60_000);
  const userDataDir = scratchDir("infinitary-gitlab-own-batches-");
  const repoDir = join(userDataDir, "field-notes");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  execFileSync("git", ["init", "--initial-branch=main", repoDir], { stdio: "pipe" });
  git("config", "user.name", "Test");
  git("config", "user.email", "test@localhost");
  git("commit", "--allow-empty", "-m", "chore: seed the notes");

  const gitlab = await startGitLabStub(HOST);
  // The project folder is its own mirror here: a branch it holds is a pushed branch.
  gitlab.headOf((branch) => git("rev-parse", `refs/heads/${branch}`));
  gitlab.runsBranches(() =>
    git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n"),
  );
  // GitLab writes each merge on the default branch: one squash commit, or a
  // merge commit that keeps every commit of the merge request.
  gitlab.onMerged((merge) => {
    if (merge.squash) {
      git("merge", "--squash", merge.sha);
      git("commit", "-m", merge.message);
    } else git("merge", "--no-ff", "-m", merge.message, merge.sha);
    return git("rev-parse", "HEAD");
  });
  gitlab.onBranchDelete((branch) => {
    git("branch", "-D", branch);
  });
  // Each batch merge request's pipeline runs until this journey ends it.
  gitlab.setPipelines([running(1), running(2)]);
  seedGitLabSignIn(userDataDir, HOST);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-notes",
    path: repoDir,
    name: "field-notes",
    setupKind: "clone",
    origin: `https://${HOST}/${GITLAB_STUB_PROJECT}.git`,
    runsOn: null,
    delivery: "queue-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();

  const changes = ["dates", "export", "legend"] as const;
  type Change = (typeof changes)[number];
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [ownBatch],
    userDataDir,
    env: { ...gitlab.env, ...SHORT_TICK },
  });
  try {
    const { page } = launched;
    const notes = async () =>
      (await page.evaluate(() => window.infinitary.repos.list())).find(
        (repo) => repo.id === "repo-notes",
      );
    const cardTitles = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title);

    // Three crewmates each commit a change, save its story and put up its merge card.
    const input = promptInput(page);
    await input.fill(ownBatchPrompt("field-notes", changes));
    await input.press("Enter");
    await expect
      .poll(async () => (await cardTitles()).sort(), { timeout: 120_000 })
      .toEqual(changes.map(ownBatchTitle).sort());
    const board = (await page.evaluate(() => window.infinitary.tasks.board())).tasks;
    const idOf = (change: Change) =>
      board.find((task) => task.title === ownBatchTask("field-notes", change))?.id ?? "";
    const saved = (change: Change) =>
      readSavedData(userDataDir, (savedDb) => new TaskStore(savedDb).get(idOf(change)));
    const approve = async (change: Change) => {
      const title = ownBatchTitle(change);
      await showCard(page, title);
      await pressKey(await completionAction(page, title), "Enter");
      await expect.poll(cardTitles, { timeout: 20_000 }).not.toContain(title);
    };

    // Each change is a pushed branch with its story: none has a merge request of its own.
    for (const change of changes) expect(idOf(change)).not.toBe("");
    expect(gitlab.mergeRequests()).toEqual([]);

    // A batch of one: the first approved change's merge request reads as its own would.
    await approve("dates");
    await expect.poll(() => gitlab.mergeRequests().length, { timeout: 30_000 }).toBe(1);
    const first = gitlab.mergeRequests()[0];
    expect(first).toMatchObject({ iid: 1, title: ownBatchTitle("dates"), state: "opened" });
    expect(first?.branch.startsWith(BATCH_BRANCH_PREFIX)).toBe(true);
    expect(first?.description).toContain(ownBatchChanged("dates"));

    // The two approved while its pipeline runs wait in line, in approval order.
    await approve("export");
    await approve("legend");
    const pair = [ownBatchTitle("export"), ownBatchTitle("legend")];
    await expect
      .poll(async () => (await notes())?.batch?.line.map((change) => change.title), {
        timeout: 20_000,
      })
      .toEqual(pair);
    expect(gitlab.merges()).toEqual([]);

    // Its pipeline passes: GitLab squashes it under the change's own title, and its task closes.
    gitlab.setPipelines([passed(1), running(2)]);
    await expect.poll(() => gitlab.merges().length, { timeout: 30_000 }).toBe(1);
    expect(gitlab.merges()[0]).toMatchObject({ iid: 1, squash: true });
    expect(gitlab.merges()[0]?.message.split("\n")[0]).toBe(ownBatchTitle("dates"));
    await expect
      .poll(() => saved("dates")?.closedReason ?? null, { timeout: 30_000 })
      .toBe("merged");
    expect(saved("dates")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: git("rev-parse", "main") },
    });

    // The next batch carries the two that waited: one merge request for both.
    await expect.poll(() => gitlab.mergeRequests().length, { timeout: 30_000 }).toBe(2);
    const second = gitlab.mergeRequests()[1];
    const title = batchTitle(
      pair.map((each) => ({ title: each })),
      BUNDLED_NAMING,
    );
    expect(second).toMatchObject({ iid: 2, title, state: "opened" });
    for (const each of pair) expect(second?.description).toContain(each);

    // Its pipeline fails: the batch holds and nothing merges.
    const heldHead = async () => (await notes())?.batch?.open?.head ?? "";
    await expect.poll(heldHead, { timeout: 30_000 }).not.toBe("");
    const failedAt = await heldHead();
    const failed = {
      status: "failed",
      iid: 2,
      head: failedAt,
      jobs: [{ name: "unit-tests", status: "failed" }],
    };
    gitlab.setPipelines([passed(1), failed]);
    await expect
      .poll(async () => (await notes())?.batch?.open?.hold, { timeout: 30_000 })
      .toMatchObject({
        reason: "checks",
        head: failedAt,
        // GitLab's failed pipeline and its failed job both read as failed checks.
        checks: expect.arrayContaining(["unit-tests"]),
      });
    expect(gitlab.merges()).toHaveLength(1);

    // Settings shows the held batch under the project, naming its merge request as GitLab does.
    await pressKey(page.getByRole("button", { name: "Settings" }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Projects" }), "Enter");
    await pressKey(projectLine(page, "repo-notes").getByRole("button"), "Enter");
    const row = projectSettings(page, "repo-notes");
    await expect(row.getByText(BATCH_OWN_WORDS.note)).toBeVisible();
    const panel = row.locator('[data-batch-hold="repo-notes"]');
    await expect(panel.getByText(BATCH_HOLD_WORDS.title)).toBeVisible();
    await expect(
      panel.getByRole("button", { name: BATCH_HOLD_WORDS.open(changeNumberLabel("gitlab", 2)) }),
    ).toBeVisible();

    // Try again, by keys: the same merge request takes a new version, and the hold ends.
    await pressKey(panel.getByRole("button", { name: BATCH_HOLD_WORDS.tryAgain }), "Enter");
    await expect(panel).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(heldHead, { timeout: 30_000 }).not.toBe(failedAt);
    expect((await notes())?.batch?.open).toMatchObject({ number: 2 });
    expect(gitlab.mergeRequests()).toHaveLength(2);
    expect(gitlab.merges()).toHaveLength(1);

    // The new version's pipeline passes: GitLab merges it without squash, under the batch's title.
    gitlab.setPipelines([passed(1), failed, passed(2)]);
    await expect.poll(() => gitlab.merges().length, { timeout: 30_000 }).toBe(2);
    expect(gitlab.merges()[1]).toMatchObject({ iid: 2, squash: false });
    expect(gitlab.merges()[1]?.message.split("\n")[0]).toBe(title);
    // The default branch keeps one commit for each change, under the merge commit.
    expect(git("log", "--format=%s", "-1", "main")).toBe(title);
    expect(git("log", "--format=%s", "-2", "main^2").split("\n")).toEqual([
      ownBatchTitle("legend"),
      ownBatchTitle("export"),
    ]);
    await expect
      .poll(() => [saved("export")?.closedReason ?? null, saved("legend")?.closedReason ?? null], {
        timeout: 30_000,
      })
      .toEqual(["merged", "merged"]);
    // Each task's receipt names its own commit on the default branch.
    expect(saved("export")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: git("rev-parse", "main^2~1") },
    });
    expect(saved("legend")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: git("rev-parse", "main^2") },
    });
    expect(gitlab.deletedBranches()).toEqual([first?.branch, second?.branch]);
  } finally {
    await launched.close();
    await gitlab.close();
  }
});
