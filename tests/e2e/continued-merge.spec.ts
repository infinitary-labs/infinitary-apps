import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { presentationCommitMessage } from "../../src/core/forge/presentation";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { MERGE_NOT_NOW_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { BUNDLED_NAMING } from "../helpers/namingRunbook";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  CONTINUED_MERGE_MARKER,
  CONTINUED_MERGE_TITLE,
  CONTINUED_PULL,
  continuedMerge,
} from "./scenarios/continuedMerge";
import {
  OWN_STORY_TITLE,
  STORIED_BRANCH,
  STORIED_CARD_TITLE,
  STORIED_CHANGES_MARKER,
  STORIED_STORY,
  STORIED_STORY_TITLE,
  storiedChanges,
} from "./scenarios/storiedChanges";
import { shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * INF-1246: the task follows another task's PR and a single keyboard merge
 * survives a conflict. Real git supplies the original and unchanged repair;
 * a disposable GitHub serves checks and the accepted merge receipt.
 * Completion is one squash at the repaired commit and a still-open task.
 * Requires desktop Electron and local git; no real sign-in or shared PR.
 */
test("a continued pull request shows its checks and merges an unchanged conflict repair on the original click", async () => {
  const userDataDir = scratchDir("infinitary-continued-merge-");
  const repoDir = join(userDataDir, "shipyard");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  git("init", "--initial-branch=main", repoDir);
  const run = (...args: string[]) => git("-C", repoDir, ...args);
  run("config", "user.name", "Test");
  run("config", "user.email", "test@localhost");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "reading.txt"), "The task reads its own branch.\n");
  run("add", ".");
  run("commit", "-m", "chore: initial reading");
  const branch = "fm/task-earlier";
  run("checkout", "-b", branch);
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "reading.txt"), "The task reads the selected pull request.\n");
  run("add", ".");
  run("commit", "-m", "fix: read the continued pull request");
  const approved = run("rev-parse", "HEAD");
  run("checkout", "main");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "guide.txt"), "The captain chooses when to merge.\n");
  run("add", ".");
  run("commit", "-m", "docs: describe the merge choice");
  const base = run("rev-parse", "HEAD");
  run("checkout", branch);
  run("rebase", "main");
  const repaired = run("rev-parse", "HEAD");
  run("checkout", "main");
  const github = await startGitHubStub();
  const pull = {
    number: CONTINUED_PULL,
    branch,
    title: "fix: read the continued pull request",
    headSha: approved,
  };
  github.serveNumbered(pull);
  github.setChecks([{ name: "unit-tests", status: "completed", conclusion: "success" }]);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-shipyard",
    path: repoDir,
    name: "shipyard",
    setupKind: "clone",
    origin: "https://github.com/octo/shipyard.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const launched = await launchApp({
    withMockProvider: true,
    userDataDir,
    env: github.env,
    scenarios: [
      continuedMerge(
        {
          fromHead: approved,
          toHead: repaired,
          newBase: base,
          impact: "none",
          changedPaths: [],
          evidence: "The same reading change sits on main's separate guide addition.",
          validation: "The selected pull request's checks passed after the unchanged repair.",
        },
        () => github.serveNumbered({ ...pull, headSha: repaired }),
      ),
    ],
  });
  try {
    const { page } = launched;
    const title = `shipyard ${CONTINUED_MERGE_MARKER}`;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    const card = shownCard(page, CONTINUED_MERGE_TITLE);
    await expect(card).toBeVisible();
    const saved = () =>
      readSavedData(userDataDir, (savedDb) =>
        new TaskStore(savedDb).list().find((task) => task.title === title),
      );
    await expect
      .poll(saved)
      .toMatchObject({ delivery: { prNumber: CONTINUED_PULL, ci: "green", headSha: approved } });
    expect(github.merges()).toEqual([]);
    // INF-2744: a merge that continues the task gets the app's Not now beside
    // it, never Discard, which would drop the task's own working copy.
    await expect(
      card.getByRole("button", { name: MERGE_NOT_NOW_WORDS, exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
    await regionShot(card, test.info().outputPath("continued-review.png"));
    github.serveNumbered({ ...pull, mergeableState: "dirty" });
    await pressKey(
      page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }),
      "Enter",
    );
    await expect
      .poll(() => github.merges())
      .toEqual([
        { number: CONTINUED_PULL, sha: repaired, method: "squash", title: pull.title, message: "" },
      ]);
    // INF-1478: the stand-in records the merge before replying; the app saves
    // the receipt and consumes the approval only after it receives that reply.
    await expect.poll(saved).toMatchObject({
      status: "active",
      delivery: {
        prNumber: CONTINUED_PULL,
        headSha: repaired,
        mergeAuthorization: {
          status: "consumed",
          approvedHead: approved,
          receipt: { head: repaired },
        },
      },
    });
    const task = await saved();
    expect(task?.worktreeDir && existsSync(task.worktreeDir)).toBe(true);
    const proof = {
      checks: task?.delivery?.ci,
      pull: task?.delivery?.prNumber,
      approval: task?.delivery?.mergeAuthorization,
      merges: github.merges(),
      status: task?.status,
    };
    writeFileSync(test.info().outputPath("continued-merge.json"), JSON.stringify(proof, null, 2));
    console.log("Continued pull request proof", JSON.stringify(proof));
  } finally {
    await launched.close();
    await github.close();
  }
});

/**
 * INF-2546 (R2, R9), under the captain's "a new list of every pull request
 * on the task": the task's own pull request and a second one it opens from
 * an existing branch each keep their own saved story, so publishing the
 * second leaves the first's description as it was; and the captain's one
 * click on the second, kept through a conflict and an unchanged repair,
 * republishes its story at the repaired version before the merge. Real git supplies both branches and
 * the repair; a disposable GitHub serves the descriptions, checks and merge.
 * Requires desktop Electron and local git; no real sign-in or shared PR.
 */
test("each pull request keeps its own saved story, and a kept approval republishes the second one's at its unchanged repair before merging it (INF-2546)", async () => {
  const userDataDir = scratchDir("infinitary-storied-changes-");
  const repoDir = join(userDataDir, "shipyard");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  git("init", "--initial-branch=main", repoDir);
  const run = (...args: string[]) => git("-C", repoDir, ...args);
  run("config", "user.name", "Test");
  run("config", "user.email", "test@localhost");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "reading.txt"), "The task reads its own branch.\n");
  run("add", ".");
  run("commit", "-m", "chore: initial reading");
  run("checkout", "-b", STORIED_BRANCH);
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "reading.txt"), "The task reads the selected pull request.\n");
  run("add", ".");
  run("commit", "-m", STORIED_STORY_TITLE);
  const approved = run("rev-parse", "HEAD");
  run("checkout", "main");
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(repoDir, "guide.txt"), "The captain chooses when to merge.\n");
  run("add", ".");
  run("commit", "-m", "docs: describe the merge choice");
  const base = run("rev-parse", "HEAD");
  // The same change on main's newer version, kept aside until the crewmate
  // moves the branch to it. A cherry-pick leaves the branch where it is,
  // whatever this computer's git does to other branches on a rebase.
  run("checkout", "-b", "repaired", "main");
  run("cherry-pick", approved);
  const repaired = run("rev-parse", "HEAD");
  run("checkout", "main");
  const github = await startGitHubStub();
  // Every branch's version where the project lives is its version here.
  github.headOf((branch) => run("rev-parse", `refs/heads/${branch}`));
  github.setChecks([{ name: "unit-tests", status: "completed", conclusion: "success" }]);
  // GitHub refuses the approved version once main moved: it conflicts.
  github.conflicts((head) => head === approved);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-shipyard",
    path: repoDir,
    name: "shipyard",
    setupKind: "clone",
    origin: "https://github.com/octo/shipyard.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const launched = await launchApp({
    withMockProvider: true,
    userDataDir,
    env: github.env,
    scenarios: [
      storiedChanges(() => ({
        fromHead: approved,
        toHead: repaired,
        newBase: base,
        impact: "none",
        changedPaths: [],
        evidence: "The same reading change sits on main's separate guide addition.",
        validation: "The pull request's checks passed after the unchanged repair.",
      })),
    ],
  });
  const descriptionWrites = (number: number) =>
    github.requests().filter((request) => request === `PATCH /repos/octo/shipyard/pulls/${number}`)
      .length;
  try {
    const { page } = launched;
    const title = `shipyard ${STORIED_CHANGES_MARKER}`;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    const card = shownCard(page, STORIED_CARD_TITLE);
    await expect(card).toBeVisible({ timeout: 60_000 });
    const saved = () =>
      readSavedData(userDataDir, (savedDb) =>
        new TaskStore(savedDb).list().find((task) => task.title === title),
      );
    // Each change keeps its own story: the second pull request's is the
    // current one, and the task's own stays published on its own number.
    const task = await saved();
    const own = task?.delivery?.presentations?.find((ledger) => ledger.branch === task.branch);
    const ownNumber = own?.published?.number as number;
    expect(own?.revisions.at(-1)?.title).toBe(OWN_STORY_TITLE);
    const second = task?.delivery?.presentation;
    const secondNumber = second?.published?.number as number;
    expect(second).toMatchObject({ branch: STORIED_BRANCH, published: { head: approved } });
    expect(second?.revisions.at(-1)?.title).toBe(STORIED_STORY_TITLE);
    expect([ownNumber, secondNumber].every(Number.isInteger)).toBe(true);
    expect(secondNumber).not.toBe(ownNumber);
    // Each opened with its own story, and neither description was written since.
    expect(descriptionWrites(ownNumber)).toBe(0);
    expect(descriptionWrites(secondNumber)).toBe(0);
    expect(github.merges()).toEqual([]);
    await regionShot(card, test.info().outputPath("storied-review.png"));

    await pressKey(
      page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }),
      "Enter",
    );
    // GitHub refused the approved version; the crewmate's unchanged repair
    // kept the click, the story went up again at the repair, then it merged.
    await expect
      .poll(() => github.merges(), { timeout: 60_000 })
      .toEqual([
        {
          number: secondNumber,
          sha: repaired,
          method: "squash",
          title: STORIED_STORY_TITLE,
          message: presentationCommitMessage(STORIED_STORY, BUNDLED_NAMING),
        },
      ]);
    expect(descriptionWrites(secondNumber)).toBe(1);
    expect(descriptionWrites(ownNumber)).toBe(0);
    await expect.poll(saved).toMatchObject({
      status: "active",
      delivery: {
        mergeAuthorization: {
          status: "consumed",
          approvedHead: approved,
          receipt: { head: repaired },
        },
      },
    });
    const after = await saved();
    expect(after?.delivery?.presentation?.published).toMatchObject({
      number: secondNumber,
      head: repaired,
    });
    writeFileSync(
      test.info().outputPath("storied-changes.json"),
      JSON.stringify(
        {
          own: after?.delivery?.presentations,
          current: after?.delivery?.presentation,
          approval: after?.delivery?.mergeAuthorization,
          requests: github.requests(),
          merges: github.merges(),
          status: after?.status,
        },
        null,
        2,
      ),
    );
  } finally {
    await launched.close();
    await github.close();
  }
});
