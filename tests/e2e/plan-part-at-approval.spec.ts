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
  releaseTask,
} from "./scenarios/partAtApproval";
import { completionAction, showCard } from "./stack";
import { pressKey } from "./windowKeys";

const PASSED = [{ name: "unit-tests", status: "completed", conclusion: "success" }];
const RUNNING = [{ name: "unit-tests", status: "in_progress", conclusion: null }];

/**
 * INF-4517 piece 3, the captain's "Approve and build" with a part starting
 * "When the part before it is approved to merge", and INF-5269's plan,
 * part 2, the captain's "Every dependency starts the later task at
 * approval, unless the filer says it needs the merge" and "When you
 * approve the part before it, down the whole chain": in a project on
 * batched pull requests, a chain of three parts filed with no start mark
 * starts each part once the captain approves the part under it, on that
 * approved version, before anything merges, even the third part, which
 * waits on both earlier parts; each merge card goes up and is approved
 * while the batch under it is checking, waits in line with no left-out
 * note, and the parts merge in order, each as one commit of its own
 * difference. A release filed as needing the first part merged waits for
 * that merge.
 *
 * Real git supplies the crewmates' commits and the app's own combine and
 * push; a disposable GitHub serves a project on batched pull requests, each
 * pushed branch's passing check and the batch pull requests the app opens,
 * and records each merge, moving the project's default branch as GitHub
 * does. The crewmates' moves are scripted (`scenarios/partAtApproval.ts`):
 * a later part's shell needs every earlier part's file, so its change
 * exists only if it started on the approved version under it. One journey:
 * each section needs the one before it. Completion signals are the host's
 * own records: the tasks' starts, the line, the merges and the default
 * branch's commits. Requires desktop Electron and local git; no real
 * sign-in or shared pull request.
 */
test("a chain of parts starts each part at the approval of the part under it and merges in order", async () => {
  test.setTimeout(6 * 60_000);
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
    const idOfTitle = async (title: string) =>
      (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (task) => task.title === title,
      )?.id ?? "";
    const idOf = (part: Part) => idOfTitle(partTask("meterlab", part));
    const saved = (id: string) =>
      readSavedData(userDataDir, (savedDb) => new TaskStore(savedDb).get(id));
    /** The captain approves a part's merge card by keys. */
    const approve = async (part: Part) => {
      const title = partTitle(part);
      await showCard(page, title);
      await pressKey(await completionAction(page, title), "Enter");
      await expect.poll(cardTitles, { timeout: 20_000 }).not.toContain(title);
    };
    /** A part's start on the approved version under it: its recorded base, and its brief's line. */
    const startsOn = async (part: Part, under: Part, id: string, underId: string) => {
      const approval = saved(underId)?.delivery?.mergeAuthorization;
      if (!approval) throw new Error(`The ${under} part's approval is kept`);
      const underKey = saved(underId)?.key ?? "";
      const builtOn = {
        task: underKey,
        branch: approval.target.branch,
        head: approval.approvedHead,
      };
      // The ready sweep claims the task before its start reads the approved version and records it.
      await expect.poll(() => saved(id)?.shape?.built_on, { timeout: 60_000 }).toEqual(builtOn);
      expect(saved(id)?.status).not.toBe("open");
      const line = renderBuiltOnLine({
        ...builtOn,
        key: underKey,
        title: partTask("meterlab", under),
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
      expect(github.merges(), `${part} starts before anything merges`).toEqual([]);
    };

    // The first mate starts the first part and files the rest behind it, with no start mark.
    const input = promptInput(page);
    await input.fill(partAtApprovalPrompt("meterlab"));
    await input.press("Enter");
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(partTitle("first"));
    await expect.poll(() => idOfTitle(releaseTask("meterlab")), { timeout: 60_000 }).not.toBe("");
    const first = await idOf("first");
    const second = await idOf("second");
    const third = await idOf("third");
    const release = await idOfTitle(releaseTask("meterlab"));
    expect(first).not.toBe("");
    expect(second).not.toBe("");
    expect(third).not.toBe("");
    expect(saved(second)?.shape?.start_at_approval).toBeUndefined();
    expect(saved(third)?.shape?.start_at_approval).toBeUndefined();
    // A merge card is not an approval: the later parts wait.
    expect(saved(second)?.status).toBe("open");

    // The captain approves the first part: its batch opens, and its checks are still running.
    await approve("first");
    await expect.poll(() => github.pulls().length, { timeout: 30_000 }).toBe(1);
    expect(github.merges()).toEqual([]);

    // The second part starts on the first part's approved version before it merges.
    await startsOn("second", "first", second, first);
    // The third part waits for the second part's approval; the release waits for the merge.
    expect(saved(third)?.status).toBe("open");
    expect(saved(release)?.status).toBe("open");

    // Its merge card goes up and is approved while the first part's batch is checking: it waits in line.
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(partTitle("second"));
    await approve("second");
    await expect
      .poll(async () => (await meterlab())?.batch?.line.map((change) => change.title), {
        timeout: 20_000,
      })
      .toEqual([partTitle("second")]);
    expect((await meterlab())?.batch?.line[0]?.after).toBe(first);

    // The third part, waiting on both, starts on the second part's approved version while neither merged.
    await startsOn("third", "second", third, second);
    expect(saved(release)?.status).toBe("open");
    expect(saved(release)?.startedAt).toBeNull();
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(partTitle("third"));
    await approve("third");
    await expect
      .poll(async () => (await meterlab())?.batch?.line.map((change) => change.title), {
        timeout: 20_000,
      })
      .toEqual([partTitle("second"), partTitle("third")]);
    const batch = (await meterlab())?.batch;
    expect(batch?.line[1]?.after).toBe(second);
    expect(batch?.leftOut).toEqual([]);
    expect(batch?.open?.members.map((member) => member.taskId)).toEqual([first]);

    // The first part's batch passes and merges; then the release starts, and the rest follow in order.
    // Every approval so far left the release unstarted: it needs the first part merged.
    expect(saved(release)?.startedAt).toBeNull();
    github.setPullChecks(100, PASSED);
    await expect
      .poll(() => github.merges()[0], { timeout: 30_000 })
      .toMatchObject({ number: 100, title: partTitle("first") });
    // The release's start is recorded only after that merge.
    await expect.poll(() => saved(release)?.startedAt ?? null, { timeout: 60_000 }).not.toBeNull();
    // The second and third parts go in one batch or two, as the line forms them.
    for (const next of [101, 102]) {
      await expect.poll(() => github.pulls().length, { timeout: 60_000 }).toBe(next - 99);
      github.setPullChecks(next, PASSED);
      await expect.poll(() => github.merges().length, { timeout: 30_000 }).toBe(next - 99);
      if (git("log", "--format=%s", "-1", "main") === partTitle("third")) break;
    }
    await expect
      .poll(() => [first, second, third].map((id) => saved(id)?.closedReason ?? null), {
        timeout: 30_000,
      })
      .toEqual(["merged", "merged", "merged"]);
    expect(git("log", "--format=%s", "-3", "main").split("\n")).toEqual([
      partTitle("third"),
      partTitle("second"),
      partTitle("first"),
    ]);
    // Each part's commit carries only its own difference.
    expect(git("show", "--name-only", "--format=", "main")).toBe("third.txt");
    expect(git("show", "--name-only", "--format=", "main~1")).toBe("second.txt");
    expect(git("show", "--name-only", "--format=", "main~2")).toBe("first.txt");
  } finally {
    await launched.close();
    await github.close();
  }
});
