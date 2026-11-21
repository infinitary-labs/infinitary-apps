import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { LEFT_OUT_WORDS } from "../../src/core/batches/combine";
import { candidateHead } from "../../src/core/orchestrator/mergeAuthorization";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp, SHORT_TICK } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  BRING_FIRST_UP_TO_DATE,
  type ChainPart,
  chainTask,
  chainTitle,
  FOLLOWED,
  followBase,
  followBasePrompt,
  MOVED_BETWEEN,
  movedSteer,
} from "./scenarios/followBase";
import { completionAction, showCard } from "./stack";
import { pressKey } from "./windowKeys";

const PASSED = [{ name: "unit-tests", status: "completed", conclusion: "success" }];
const RUNNING = [{ name: "unit-tests", status: "in_progress", conclusion: null }];

/**
 * INF-5269's plan, part 3, the captain's "Approve and build": a part that
 * started on the approved version of the part under it follows that part.
 * When the part under it is approved at a newer version, the part is told
 * once, with both versions and how to replay only its own commits. Under
 * the captain's kept approval, its repair onto that newer version is
 * accepted with only its own paths compared, and the approval stays. Without
 * an approval, a merge card at a version that does not hold the newer
 * version is refused in the batch line's words, and the card at the
 * replayed version goes up and moves its recorded base. The parts still
 * merge in order, each as one commit of its own difference.
 *
 * Real git supplies the crewmates' commits, rebases and the app's own
 * combine and push; a disposable GitHub serves a project on batched pull
 * requests, each pushed branch's passing check and the batch pull requests
 * the app opens, and records each merge, moving the project's default
 * branch as GitHub does. The crewmates' moves are scripted
 * (`scenarios/followBase.ts`); the first part's move starts from the
 * journey's own words in its Crewmate tab, after the journey moves the
 * default branch. One journey: each section needs the one before it.
 * Completion signals are the host's own records: the tasks' recorded
 * bases and approvals, the steers in the crewmates' requests, the merges and
 * the default branch's commits. Requires desktop Electron and local git; no
 * real sign-in or shared pull request.
 */
test("a chained part follows the newer approved version of the part under it", async () => {
  test.setTimeout(8 * 60_000);
  const userDataDir = scratchDir("infinitary-follow-base-");
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
    scenarios: [followBase],
    userDataDir,
    env: { ...github.env, ...SHORT_TICK },
  });
  try {
    const { page } = launched;
    const cardTitles = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title);
    const idOf = async (part: ChainPart) => {
      const title = chainTask("meterlab", part);
      return (
        (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (task) => task.title === title,
        )?.id ?? ""
      );
    };
    const saved = (id: string) =>
      readSavedData(userDataDir, (savedDb) => new TaskStore(savedDb).get(id));
    const builtOn = (id: string) => saved(id)?.shape?.built_on?.head;
    /** The newest version the captain's kept approval of a part covers. */
    const approvedAt = (id: string) => {
      const approval = saved(id)?.delivery?.mergeAuthorization;
      return approval ? candidateHead(approval) : undefined;
    };
    /** The captain approves a part's merge card by keys. */
    const approve = async (part: ChainPart) => {
      const title = chainTitle(part);
      await showCard(page, title);
      await pressKey(await completionAction(page, title), "Enter");
      await expect.poll(cardTitles, { timeout: 20_000 }).not.toContain(title);
    };
    const bodies = () => launched.mockProvider?.requestBodies() ?? [];
    /**
     * How many times the most complete request carries these words, as a
     * request's JSON writes them: a steer heard twice shows twice.
     */
    const heard = (words: string) => {
      const written = JSON.stringify(words).slice(1, -1);
      return Math.max(0, ...bodies().map((body) => body.split(written).length - 1));
    };
    /** The base-moved steer a part hears when the part under it, `underId`, moved from `from` to `to`. */
    const moved = (underId: string, under: ChainPart, from: string, to: string) => {
      const base = saved(underId);
      return movedSteer(
        {
          key: base?.key || (base?.id ?? ""),
          title: chainTask("meterlab", under),
          branch: base?.delivery?.mergeAuthorization?.target.branch ?? "",
        },
        from,
        to,
      );
    };

    // The first mate starts the first part and files the rest behind it.
    const input = promptInput(page);
    await input.fill(followBasePrompt("meterlab"));
    await input.press("Enter");
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(chainTitle("first"));
    await expect.poll(() => idOf("third"), { timeout: 60_000 }).not.toBe("");
    const first = await idOf("first");
    const second = await idOf("second");
    const third = await idOf("third");

    // The captain approves the first part; the second starts on it, and the third on the second.
    await approve("first");
    const firstApproved = approvedAt(first) ?? "";
    await expect.poll(() => builtOn(second), { timeout: 60_000 }).toBe(firstApproved);
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(chainTitle("second"));
    await approve("second");
    const secondApproved = approvedAt(second) ?? "";
    await expect.poll(() => builtOn(third), { timeout: 60_000 }).toBe(secondApproved);
    await expect.poll(cardTitles, { timeout: 120_000 }).toContain(chainTitle("third"));
    const thirdOffered = git("rev-parse", `refs/heads/${saved(third)?.branch}`);
    // Nothing moved yet: no part is told the part under it moved.
    expect(heard(MOVED_BETWEEN)).toBe(0);
    expect(github.merges()).toEqual([]);

    // The default branch moves, and the first part is brought up to date under its kept approval.
    writeFileSync(join(repoDir, "dial.txt"), "dial\n");
    git("add", "dial.txt");
    git("commit", "-m", "chore: add the dial");
    await page.evaluate(([id, words]) => window.infinitary.task.steer(id, words), [
      first,
      BRING_FIRST_UP_TO_DATE,
    ] as const);
    await expect.poll(() => approvedAt(first), { timeout: 120_000 }).not.toBe(firstApproved);
    const firstRepaired = approvedAt(first) ?? "";
    // The repaired first part is its own commit on the moved default branch.
    expect(git("rev-parse", `${firstRepaired}~1`)).toBe(git("rev-parse", "main"));

    // told-newer and repair-accepts: the second part hears once, replays, and its repair is accepted.
    await expect
      .poll(() => heard(moved(first, "first", firstApproved, firstRepaired)), {
        timeout: 120_000,
      })
      .toBe(1);
    await expect.poll(() => approvedAt(second), { timeout: 120_000 }).not.toBe(secondApproved);
    const secondRepaired = approvedAt(second) ?? "";
    expect(saved(second)?.delivery?.mergeAuthorization?.approvedHead).toBe(secondApproved);
    await expect.poll(() => builtOn(second), { timeout: 30_000 }).toBe(firstRepaired);
    // The repaired second part holds the first part's newer version and only its own commit on it.
    expect(git("rev-parse", `${secondRepaired}~1`)).toBe(firstRepaired);
    expect(git("show", "--name-only", "--format=", secondRepaired)).toBe("second.txt");

    // told-newer and stale-card-refused: the third part hears once; its card at the old version is refused.
    // DIAGNOSTIC (to be reverted): sample the main process's stack while waiting.
    const samples: string[] = [];
    const sampler = setInterval(() => {
      void Promise.race([
        launched.app.evaluate(() => {
          Error.stackTraceLimit = 200;
          return `${new Error("sample").stack}`;
        }),
        new Promise<string>((resolve) => setTimeout(() => resolve("(no answer in 10s)"), 10_000)),
      ]).then((stack) => {
        if (samples.length < 6) samples.push(stack);
      });
    }, 15_000);
    try {
      await expect
        .poll(() => heard(moved(second, "second", secondApproved, secondRepaired)), {
          timeout: 120_000,
        })
        .toBe(1);
    } catch (caught) {
      for (const [index, stack] of samples.entries())
        console.log(`[diagnostic] main stack sample ${index}:\n${stack}`);
      throw caught;
    } finally {
      clearInterval(sampler);
    }
    await expect
      .poll(() => heard(LEFT_OUT_WORDS.behindBase(secondRepaired)), { timeout: 120_000 })
      .toBe(1);
    // The card at the replayed version goes up after its story, and the third part reports it.
    await expect.poll(() => heard(FOLLOWED("third")), { timeout: 120_000 }).toBeGreaterThan(0);
    expect(git("rev-parse", `refs/heads/${saved(third)?.branch}`)).not.toBe(thirdOffered);
    // Its recorded base moved with that card.
    expect(builtOn(third)).toBe(secondRepaired);
    expect(await cardTitles()).toContain(chainTitle("third"));
    await approve("third");
    // Each part heard each move exactly once, after every sweep so far.
    expect(heard(moved(first, "first", firstApproved, firstRepaired))).toBe(1);
    expect(heard(moved(second, "second", secondApproved, secondRepaired))).toBe(1);

    // The batches pass and merge the parts in order, each as one commit of its own difference.
    github.setOpenedChecks(PASSED);
    for (const pull of github.pulls())
      if (!pull.merged && !pull.closed) github.setPullChecks(pull.number, PASSED);
    await expect
      .poll(() => [first, second, third].map((id) => saved(id)?.closedReason ?? null), {
        timeout: 180_000,
      })
      .toEqual(["merged", "merged", "merged"]);
    expect(git("log", "--format=%s", "-4", "main").split("\n")).toEqual([
      chainTitle("third"),
      chainTitle("second"),
      chainTitle("first"),
      "chore: add the dial",
    ]);
    expect(git("show", "--name-only", "--format=", "main")).toBe("third.txt");
    expect(git("show", "--name-only", "--format=", "main~1")).toBe("second.txt");
    expect(git("show", "--name-only", "--format=", "main~2")).toBe("first.txt");
  } finally {
    await launched.close();
    await github.close();
  }
});
