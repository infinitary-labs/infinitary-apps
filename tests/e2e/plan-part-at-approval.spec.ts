import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { renderBuiltOnLine } from "../../src/core/orchestrator/intentBrief";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp, SHORT_TICK } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  type Part,
  partAtApproval,
  partAtApprovalPrompt,
  partTask,
  partTitle,
} from "./scenarios/partAtApproval";
import { completionAction, showCard } from "./stack";
import { pressKey } from "./windowKeys";

const PASSED = [{ name: "unit-tests", status: "completed", conclusion: "success" }];
const RUNNING = [{ name: "unit-tests", status: "in_progress", conclusion: null }];

/**
 * INF-4517 piece 3, the captain's "Approve and build" with a part starting
 * "When the part before it is approved to merge": a later part marked to
 * start at the approval of the part before it starts once the captain
 * approves that part's merge, on the approved version, before it merges;
 * the later part's own merge card goes up and is approved while the
 * earlier part's batch is still checking, waits in line with no left-out
 * note, and merges after it as one commit of its own difference.
 *
 * Real git supplies both crewmates' commits and the app's own combine and
 * push; a disposable GitHub serves a project on batched pull requests, each
 * pushed branch's passing check and the batch pull requests the app opens,
 * and records each merge, moving the project's default branch as GitHub
 * does. The crewmates' moves are scripted (`scenarios/partAtApproval.ts`):
 * the later part's shell needs the earlier part's file, so its change exists
 * only if it started on the approved version. One journey: each section
 * needs the one before it. Completion signals are the host's own records:
 * the task's start, the line, the merges and the default branch's commits.
 * Requires desktop Electron and local git; no real sign-in or shared pull
 * request.
 */
test("a plan part marked to start at approval starts on the earlier part's approved version and merges behind it", async () => {
  test.setTimeout(5 * 60_000);
  const userDataDir = scratchDir("infinitary-part-at-approval-");
  const { repoDir } = seedRepo(userDataDir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  const github = await startGitHubStub();
  github.headOf((branch) => git("rev-parse", `refs/heads/${branch}`));
  github.onPutIn((sha) => {
    git("merge", "--ff-only", sha);
  });
  github.onBranchDelete((branch) => {
    git("branch", "-D", branch);
  });
  github.setChecks(PASSED);
  github.setOpenedChecks(RUNNING);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repoDir,
    name: "meterlab",
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "queue-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();

  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [partAtApproval],
    userDataDir,
    env: { ...github.env, ...SHORT_TICK },
  });
  try {
    const { page } = launched;
    const meterlab = async () =>
      (await page.evaluate(() => window.infinitary.repos.list())).find(
        (repo) => repo.id === "repo-meterlab",
      );
    const cardTitles = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title);
    const idOf = async (part: Part) =>
      (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (task) => task.title === partTask("meterlab", part),
      )?.id ?? "";
    const saved = (id: string) =>
      readSavedData(userDataDir, (savedDb) => new TaskStore(savedDb).get(id));
    /** The captain approves a part's merge card by keys. */
    const approve = async (part: Part) => {
      const title = partTitle(part);
      await showCard(page, title);
      await pressKey(await completionAction(page, title), "Enter");
      await expect.poll(cardTitles, { timeout: 20_000 }).not.toContain(title);
    };

    // The first mate starts the first part and files the second behind it, marked to start at its approval.
    const input = promptInput(page);
    await input.fill(partAtApprovalPrompt("meterlab"));
    await input.press("Enter");
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(partTitle("first"));
    const first = await idOf("first");
    const second = await idOf("second");
    expect(first).not.toBe("");
    expect(second).not.toBe("");
    // A merge card is not an approval: the second part waits.
    expect(saved(second)?.status).toBe("open");

    // The captain approves the first part: its batch opens, and its checks are still running.
    await approve("first");
    await expect.poll(() => github.pulls().length, { timeout: 30_000 }).toBe(1);
    const approval = saved(first)?.delivery?.mergeAuthorization;
    if (!approval) throw new Error("The first part's approval is kept");
    expect(github.merges()).toEqual([]);

    // The second part starts on the approved version before it merges, and its brief says so.
    // The ready sweep claims the task before its start reads the approved version and records it.
    const firstKey = saved(first)?.key ?? "";
    const builtOn = { task: firstKey, branch: approval.target.branch, head: approval.approvedHead };
    await expect.poll(() => saved(second)?.shape?.built_on, { timeout: 60_000 }).toEqual(builtOn);
    expect(saved(second)?.status).not.toBe("open");
    const line = renderBuiltOnLine({
      ...builtOn,
      key: firstKey,
      title: partTask("meterlab", "first"),
    });
    // The task starts before its crewmate's first request goes out: wait for that request.
    await expect
      .poll(
        () =>
          launched.mockProvider
            ?.requestBodies()
            .some((body) => body.includes(JSON.stringify(line).slice(1, -1))),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(github.merges()).toEqual([]);

    // Its merge card goes up and is approved while the first part's batch is checking: it waits in line.
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(partTitle("second"));
    await approve("second");
    await expect
      .poll(async () => (await meterlab())?.batch?.line.map((change) => change.title), {
        timeout: 20_000,
      })
      .toEqual([partTitle("second")]);
    const batch = (await meterlab())?.batch;
    expect(batch?.line[0]?.after).toBe(first);
    expect(batch?.leftOut).toEqual([]);
    expect(batch?.open?.members.map((member) => member.taskId)).toEqual([first]);

    // The first part's batch passes and merges; the second goes in the next batch, as its own change.
    github.setPullChecks(100, PASSED);
    await expect
      .poll(() => github.merges()[0], { timeout: 30_000 })
      .toMatchObject({ number: 100, title: partTitle("first") });
    await expect.poll(() => github.pulls().length, { timeout: 60_000 }).toBe(2);
    expect(github.pulls()[1]).toMatchObject({ number: 101, title: partTitle("second") });
    github.setPullChecks(101, PASSED);
    await expect
      .poll(() => github.merges()[1], { timeout: 30_000 })
      .toMatchObject({ number: 101, title: partTitle("second") });
    await expect
      .poll(() => [saved(first)?.closedReason ?? null, saved(second)?.closedReason ?? null], {
        timeout: 30_000,
      })
      .toEqual(["merged", "merged"]);
    expect(git("log", "--format=%s", "-2", "main").split("\n")).toEqual([
      partTitle("second"),
      partTitle("first"),
    ]);
    // The second part's commit carries only its own difference.
    expect(git("show", "--name-only", "--format=", "main")).toBe("second.txt");
  } finally {
    await launched.close();
    await github.close();
  }
});
