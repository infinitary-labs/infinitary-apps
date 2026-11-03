import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  CONTINUED_MERGE_MARKER,
  CONTINUED_MERGE_TITLE,
  CONTINUED_PULL,
  continuedMerge,
} from "./scenarios/continuedMerge";
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
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'quick')",
  ).run("repo-shipyard", repoDir, "shipyard", Date.now(), "https://github.com/octo/shipyard.git");
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
