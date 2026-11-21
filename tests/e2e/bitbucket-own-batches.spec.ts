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
import {
  BITBUCKET_STUB_PROJECT,
  type BitbucketStubStatus,
  seedBitbucketSignIn,
  startBitbucketStub,
} from "./bitbucketStub";
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

/** A build status on a batch pull request's version, as its check service posts it. */
const build = (state: BitbucketStubStatus["state"]): BitbucketStubStatus[] => [
  { key: "unit-tests", name: "unit-tests", state },
];

/**
 * INF-5186's approved Bitbucket plan, piece 5, for the captain's "adding
 * bitbucket as another forge integration just like github and gitlab,
 * reaching parity as much as possible": batches of the captain's own reach
 * Bitbucket Cloud as they do GitLab. A batch of one is one pull request
 * squashed under the change's title; a batch of several keeps one commit
 * per change, with Bitbucket's rebase merge where the branch allows it. A
 * batch whose build failed holds, and Try again in Settings, by keys,
 * combines it again on the same pull request. With Bitbucket's merge queue
 * on the main branch, the merge Bitbucket answers with its queue reads as
 * queued, nothing is sent again, and the batch finishes once the queue
 * merges it.
 *
 * Real git supplies three crewmates' commits and the app's own combine and
 * push; a disposable Bitbucket (`./bitbucketStub.ts`) serves the project
 * with every merge strategy allowed, a passed build on each pushed branch,
 * the pull requests the app opens and their builds, and records each merge,
 * writing it to main as Bitbucket does: a squash commit, or the batch's
 * commits rebased onto main under a merge commit. The crewmates' moves are
 * scripted (`scenarios/ownBatch.ts`). One journey: its sections share the
 * project and each needs the batch before it. Completion signals are
 * Bitbucket's own records: the pull requests opened, the merges made, the
 * queue, main's commits and each task's close. Requires desktop Electron
 * and local git; no real sign-in or shared pull request.
 */
test("approved changes of a Bitbucket project merge in batches of the captain's own: one squashed, two rebased as their own commits through the merge queue after Try again by keys", async () => {
  test.setTimeout(5 * 60_000);
  const userDataDir = scratchDir("infinitary-bitbucket-own-batches-");
  const repoDir = join(userDataDir, "field-notes");
  const git = (args: string[], options: { input?: string; date?: string } = {}) =>
    execFileSync("git", ["-C", repoDir, ...args], {
      stdio: "pipe",
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.date
        ? {
            env: {
              ...process.env,
              GIT_COMMITTER_DATE: options.date,
              GIT_AUTHOR_DATE: options.date,
            },
          }
        : {}),
    })
      .toString()
      .trim();
  execFileSync("git", ["init", "--initial-branch=main", repoDir], { stdio: "pipe" });
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@localhost"]);
  git(["commit", "--allow-empty", "-m", "chore: seed the notes"]);

  const bitbucket = await startBitbucketStub();
  // The project folder is its own mirror here: a branch it holds is a pushed branch.
  bitbucket.gitOf({
    head: (branch) => git(["rev-parse", "--verify", `refs/heads/${branch}`]),
    commit: (rev) => git(["rev-parse", "--verify", `${rev}^{commit}`]),
  });
  // Bitbucket writes each merge on main: one squash commit, or for a rebase
  // merge each commit rewritten onto main under a merge commit.
  bitbucket.onMerged((merge) => {
    if (merge.strategy === "squash") {
      git(["merge", "--squash", merge.head]);
      git(["commit", "-m", merge.message]);
    } else if (merge.strategy === "rebase_merge") {
      let tip = git(["rev-parse", "main"]);
      const commits = git(["rev-list", "--reverse", `main..${merge.head}`]).split("\n");
      for (const commit of commits)
        tip = git(["commit-tree", `${commit}^{tree}`, "-p", tip, "-F", "-"], {
          input: git(["log", "-1", "--format=%B", commit]),
          // Rebased later, so each commit is a new one.
          date: "2030-01-01T00:00:00Z",
        });
      git(["merge", "--no-ff", "-m", merge.message, tip]);
    } else git(["merge", "--no-ff", "-m", merge.message, merge.head]);
    return git(["rev-parse", "HEAD"]);
  });
  bitbucket.onBranchDelete((branch) => {
    git(["branch", "-D", branch]);
  });
  // Each batch pull request's build runs until this journey ends it.
  bitbucket.setPullRequestStatuses(1, build("INPROGRESS"));
  bitbucket.setPullRequestStatuses(2, build("INPROGRESS"));
  seedBitbucketSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-notes",
    path: repoDir,
    name: "field-notes",
    setupKind: "clone",
    origin: `https://bitbucket.org/${BITBUCKET_STUB_PROJECT}.git`,
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
    env: { ...bitbucket.env, ...SHORT_TICK },
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

    // Each change is a pushed branch with its story: none has a pull request of its own.
    for (const change of changes) expect(idOf(change)).not.toBe("");
    expect(bitbucket.pullRequests()).toEqual([]);

    // A batch of one: the first approved change's pull request reads as its own would.
    await approve("dates");
    await expect.poll(() => bitbucket.pullRequests().length, { timeout: 30_000 }).toBe(1);
    const first = bitbucket.pullRequests()[0];
    expect(first).toMatchObject({ id: 1, title: ownBatchTitle("dates"), state: "OPEN" });
    expect(first?.branch.startsWith(BATCH_BRANCH_PREFIX)).toBe(true);
    expect(first?.description).toContain(ownBatchChanged("dates"));

    // The two approved while its build runs wait in line, in approval order.
    await approve("export");
    await approve("legend");
    const pair = [ownBatchTitle("export"), ownBatchTitle("legend")];
    await expect
      .poll(async () => (await notes())?.batch?.line.map((change) => change.title), {
        timeout: 20_000,
      })
      .toEqual(pair);
    expect(bitbucket.merges()).toEqual([]);

    // Its build passes: Bitbucket squashes it under the change's own title, and its task closes.
    bitbucket.setPullRequestStatuses(1, build("SUCCESSFUL"));
    await expect.poll(() => bitbucket.merges().length, { timeout: 30_000 }).toBe(1);
    expect(bitbucket.merges()[0]).toMatchObject({ id: 1, strategy: "squash" });
    expect(bitbucket.merges()[0]?.message.split("\n")[0]).toBe(ownBatchTitle("dates"));
    await expect
      .poll(() => saved("dates")?.closedReason ?? null, { timeout: 30_000 })
      .toBe("merged");
    expect(saved("dates")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: git(["rev-parse", "main"]) },
    });

    // The next batch carries the two that waited: one pull request for both.
    await expect.poll(() => bitbucket.pullRequests().length, { timeout: 30_000 }).toBe(2);
    const second = bitbucket.pullRequests()[1];
    const title = batchTitle(
      pair.map((each) => ({ title: each })),
      BUNDLED_NAMING,
    );
    expect(second).toMatchObject({ id: 2, title, state: "OPEN" });
    for (const each of pair) expect(second?.description).toContain(each);

    // Its build fails: the batch holds and nothing merges.
    const heldHead = async () => (await notes())?.batch?.open?.head ?? "";
    await expect.poll(heldHead, { timeout: 30_000 }).not.toBe("");
    const failedAt = await heldHead();
    bitbucket.setPullRequestStatuses(2, build("FAILED"), failedAt);
    await expect
      .poll(async () => (await notes())?.batch?.open?.hold, { timeout: 30_000 })
      .toMatchObject({
        reason: "checks",
        head: failedAt,
        checks: expect.arrayContaining(["unit-tests"]),
      });
    expect(bitbucket.merges()).toHaveLength(1);

    // Settings shows the held batch under the project, naming its pull request as Bitbucket does.
    await pressKey(page.getByRole("button", { name: "Settings" }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Projects" }), "Enter");
    await pressKey(projectLine(page, "repo-notes").getByRole("button"), "Enter");
    const row = projectSettings(page, "repo-notes");
    await expect(row.getByText(BATCH_OWN_WORDS.note)).toBeVisible();
    const panel = row.locator('[data-batch-hold="repo-notes"]');
    await expect(panel.getByText(BATCH_HOLD_WORDS.title)).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: BATCH_HOLD_WORDS.open(changeNumberLabel("bitbucket", 2)),
      }),
    ).toBeVisible();

    // Bitbucket's merge queue is turned on for main while the batch holds.
    bitbucket.mergeQueue(true);

    // Try again, by keys: the same pull request takes a new version, and the hold ends.
    await pressKey(panel.getByRole("button", { name: BATCH_HOLD_WORDS.tryAgain }), "Enter");
    await expect(panel).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(heldHead, { timeout: 30_000 }).not.toBe(failedAt);
    const repairedAt = await heldHead();
    expect((await notes())?.batch?.open).toMatchObject({ number: 2 });
    expect(bitbucket.pullRequests()).toHaveLength(2);
    expect(bitbucket.merges()).toHaveLength(1);

    // The new version's build passes: Bitbucket answers the merge with its queue, which reads as queued.
    bitbucket.setPullRequestStatuses(2, build("SUCCESSFUL"), repairedAt);
    await expect
      .poll(async () => (await notes())?.batch?.open?.queued ?? null, { timeout: 30_000 })
      .toBe(repairedAt);
    expect(bitbucket.queued()).toEqual([2]);
    expect(bitbucket.merges()).toHaveLength(1);
    expect(saved("export")?.closedReason ?? null).toBeNull();

    // The queue merges it with a rebase merge under the batch's title, and both tasks close.
    bitbucket.landQueued(2);
    expect(bitbucket.merges()[1]).toMatchObject({ id: 2, strategy: "rebase_merge" });
    expect(bitbucket.merges()[1]?.message.split("\n")[0]).toBe(title);
    // Main keeps one commit for each change, rebased under the merge commit.
    expect(git(["log", "--format=%s", "-1", "main"])).toBe(title);
    expect(git(["log", "--format=%s", "-2", "main^2"]).split("\n")).toEqual([
      ownBatchTitle("legend"),
      ownBatchTitle("export"),
    ]);
    await expect
      .poll(() => [saved("export")?.closedReason ?? null, saved("legend")?.closedReason ?? null], {
        timeout: 30_000,
      })
      .toEqual(["merged", "merged"]);
    // Each task's receipt names its own rebased commit on main.
    expect(saved("export")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: git(["rev-parse", "main^2~1"]) },
    });
    expect(saved("legend")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: git(["rev-parse", "main^2"]) },
    });
    // The queue's merge was asked for once, and the app deleted each merged batch's branch.
    expect(bitbucket.merges()).toHaveLength(2);
    expect(bitbucket.deletedBranches()).toEqual([first?.branch, second?.branch]);
  } finally {
    await launched.close();
    await bitbucket.close();
  }
});
