import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { batchTitle } from "../../src/core/batches/batches";
import { BATCH_DESCRIPTION_WORDS } from "../../src/core/batches/description";
import {
  BATCH_STORIES_MARKER,
  presentationBodyLimit,
  presentationRegionMarkers,
} from "../../src/core/forge/presentation";
import { BATCH_SENT_BACK_WORDS } from "../../src/core/orchestrator/deliveryWakes";
import { COVERED_BATCH_STEP } from "../../src/core/orchestrator/mergeAuthorization";
import { BATCH_HELD_OPENING } from "../../src/core/orchestrator/noticeWakes";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { BATCH_HOLD_WORDS, BATCH_OWN_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { BATCH_BRANCH_PREFIX } from "../../src/shared/batches";
import { branchComparePage, changeNumberLabel } from "../../src/shared/forge";
import { BATCH_CHECK_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { BUNDLED_NAMING } from "../helpers/namingRunbook";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp, SHORT_TICK } from "./launch";
import { heroShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { projectLine, projectSettings } from "./projects";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import { readSavedData } from "./savedData";
import {
  ownBatch,
  ownBatchChanged,
  ownBatchPrompt,
  ownBatchRepaired,
  ownBatchTask,
  ownBatchTitle,
} from "./scenarios/ownBatch";
import { completionAction, factsStrip, showCard } from "./stack";
import { focusOn, pressKey, typeInto } from "./windowKeys";

const PASSED = [{ name: "unit-tests", status: "completed", conclusion: "success" }];
const RUNNING = [{ name: "unit-tests", status: "in_progress", conclusion: null }];
// INF-5097: the journeys never ran on the held batch, so its send-back names them.
const FAILED = [
  { name: "unit-tests", status: "completed", conclusion: "failure" },
  { name: "journeys", status: "completed", conclusion: "skipped" },
];

/**
 * INF-3759 piece 1, the captain's approved plan for batches of their own:
 * "each change is a pushed branch with its saved story and no pull request
 * of its own. The merge click ... keeps the approval at that version and
 * puts the change in line", the app combines the line into one pull request
 * with "one commit per change", "A batch of one reads and merges exactly as
 * that change's pull request does today", a failed batch holds while
 * "changes approved meanwhile wait in line", and Settings → Projects shows
 * a held batch with its pull request, Try again and Send back with a
 * reason, by keys. INF-4759, a bug being fixed: a batch whose stories
 * together pass GitHub's description limit still opens, with every change
 * listed and each story once, the ones past the description in the app's
 * own comments, which follow the batch as its changes change. INF-5097
 * piece 1: a change sent back keeps its approval while its crewmate reads
 * why and the checks to run before showing it again; its repair, declared
 * changed work, comes back on a merge card whose Batch check says how often
 * it was sent back and why, and merges once approved.
 *
 * Real git supplies five crewmates' commits and the app's own combine and
 * push; a disposable GitHub serves a project on batched pull requests,
 * each pushed branch's passing check, the batch pull requests the app
 * opens and their checks, and records each merge, moving the project's
 * default branch as GitHub does. The crewmates' moves are scripted
 * (`scenarios/ownBatch.ts`). One journey, in the order a day's work takes:
 * its sections share the project and each needs the batch before it.
 * Completion signals are the host's own records: the pull requests opened,
 * the merges accepted, the default branch's commits and each task's close.
 * Requires desktop Electron and local git; no real sign-in or shared pull
 * request.
 */
test("approved changes of a batched project merge in batches of the captain's own, and a failed batch holds until Settings sends one change back by keys", async () => {
  test.setTimeout(6 * 60_000);
  const userDataDir = scratchDir("infinitary-own-batches-");
  const { repoDir } = seedRepo(userDataDir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  const github = await startGitHubStub();
  github.headOf((branch) => git("rev-parse", `refs/heads/${branch}`));
  // GitHub's merge moves the project's default branch; the project folder is its own mirror here.
  github.onPutIn((sha) => {
    git("merge", "--ff-only", sha);
  });
  github.onBranchDelete((branch) => {
    git("branch", "-D", branch);
  });
  // Each change's own pushed branch passed its check; a batch pull request's
  // checks run until this journey ends them.
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

  const changes = ["dates", "export", "legend", "axis", "grid"] as const;
  type Change = (typeof changes)[number];
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [ownBatch],
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

    // Five crewmates each commit a change, save its story and put up its merge card.
    const input = promptInput(page);
    await input.fill(ownBatchPrompt("meterlab", changes));
    await input.press("Enter");
    await expect
      .poll(async () => (await cardTitles()).sort(), { timeout: 120_000 })
      .toEqual(changes.map(ownBatchTitle).sort());
    const board = (await page.evaluate(() => window.infinitary.tasks.board())).tasks;
    const idOf = (change: Change) =>
      board.find((task) => task.title === ownBatchTask("meterlab", change))?.id ?? "";
    const saved = (change: Change) =>
      readSavedData(userDataDir, (savedDb) => new TaskStore(savedDb).get(idOf(change)));
    const approve = async (change: Change) => {
      const title = ownBatchTitle(change);
      await showCard(page, title);
      await pressKey(await completionAction(page, title), "Enter");
      await expect.poll(cardTitles, { timeout: 20_000 }).not.toContain(title);
    };

    for (const change of changes) {
      expect(idOf(change)).not.toBe("");
      expect(saved(change)?.delivery?.prNumber).toBeUndefined();
    }
    expect(github.pulls()).toEqual([]);

    // INF-4196: a change with no pull request of its own still has a page to open. Its
    // merge card links the branch's name to its compare page on GitHub, which opens on
    // Enter, and its merge says it goes in the next batch.
    await launched.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const branch = saved("dates")?.branch ?? "";
    const comparePage = branchComparePage({
      kind: "github",
      host: "github.com",
      owner: "o",
      name: "meterlab",
      base: "main",
      branch,
    });
    if (!branch || !comparePage) throw new Error("The change has a pushed branch on GitHub");
    await showCard(page, ownBatchTitle("dates"));
    await expect(
      page
        .locator("[data-card-layer]")
        .getByRole("button", { name: MERGE_WORDS.batch, exact: true }),
    ).toBeVisible();
    const link = factsStrip(cardBody(page, ownBatchTitle("dates"))).change.getByRole("link", {
      name: branch,
    });
    await expect(link).toHaveAttribute("href", comparePage, { timeout: 30_000 });
    await pressKey(link, "Enter");
    await expect
      .poll(() =>
        launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []),
      )
      .toEqual([comparePage]);

    // A batch of one: the first approved change's pull request reads as its own would.
    await approve("dates");
    await expect.poll(() => github.pulls().length, { timeout: 30_000 }).toBe(1);
    const first = github.pulls()[0];
    expect(first).toMatchObject({ number: 100, title: ownBatchTitle("dates"), merged: false });
    expect(first?.branch.startsWith(BATCH_BRANCH_PREFIX)).toBe(true);
    expect(first?.body).toContain(ownBatchChanged("dates"));

    // Changes approved while that batch's checks run wait in line, in approval order.
    await approve("export");
    await approve("legend");
    await expect
      .poll(async () => (await meterlab())?.batch?.line.map((change) => change.title), {
        timeout: 20_000,
      })
      .toEqual([ownBatchTitle("export"), ownBatchTitle("legend")]);
    expect(github.pulls()).toHaveLength(1);
    expect(github.merges()).toEqual([]);

    // Its checks pass: it merges as that change's pull request does today, and its task closes.
    github.setPullChecks(100, PASSED);
    await expect
      .poll(() => github.merges(), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({ number: 100, method: "squash", title: ownBatchTitle("dates") }),
      ]);
    await expect
      .poll(() => saved("dates")?.closedReason ?? null, { timeout: 30_000 })
      .toBe("merged");

    // The next batch carries the two changes that waited: one pull request, two commits.
    await expect.poll(() => github.pulls().length, { timeout: 30_000 }).toBe(2);
    const second = github.pulls()[1];
    const pair = [ownBatchTitle("export"), ownBatchTitle("legend")];
    expect(second).toMatchObject({
      number: 101,
      title: batchTitle(
        pair.map((title) => ({ title })),
        BUNDLED_NAMING,
      ),
      merged: false,
    });
    for (const title of pair) expect(second?.body).toContain(title);
    expect(second?.body).toContain(ownBatchChanged("export"));
    expect(second?.body).toContain(ownBatchChanged("legend"));
    // Two more are approved behind it, and wait in line for the batch after.
    await approve("axis");
    await approve("grid");
    await expect
      .poll(async () => (await meterlab())?.batch?.line.map((change) => change.title), {
        timeout: 20_000,
      })
      .toEqual([ownBatchTitle("axis"), ownBatchTitle("grid")]);
    github.setPullChecks(101, PASSED);
    await expect
      .poll(() => github.merges()[1], { timeout: 30_000 })
      .toMatchObject({ number: 101, method: "rebase" });
    expect(git("log", "--format=%s", "-3", "main").split("\n")).toEqual([
      ownBatchTitle("legend"),
      ownBatchTitle("export"),
      ownBatchTitle("dates"),
    ]);
    const exportCommit = git("rev-parse", "main~1");
    const legendCommit = git("rev-parse", "main");
    await expect
      .poll(() => [saved("export")?.closedReason ?? null, saved("legend")?.closedReason ?? null], {
        timeout: 30_000,
      })
      .toEqual(["merged", "merged"]);
    expect(saved("export")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: exportCommit },
    });
    expect(saved("legend")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { sha: legendCommit },
    });
    expect(github.deletedBranches()).toEqual([first?.branch, second?.branch]);

    // The third batch's checks fail: it holds, nothing merges, and the first mate hears of it.
    await expect.poll(() => github.pulls().length, { timeout: 30_000 }).toBe(3);
    expect(github.pulls()[2]).toMatchObject({
      number: 102,
      title: batchTitle(
        [{ title: ownBatchTitle("axis") }, { title: ownBatchTitle("grid") }],
        BUNDLED_NAMING,
      ),
    });
    // INF-4759: the two stories pass GitHub's description limit together, though each fits
    // alone. The description lists both changes, holds the first story and says one follows;
    // the second follows in the app's own comment, and each story is there once.
    const third = github.pulls()[2];
    await expect.poll(() => github.comments(102).length, { timeout: 30_000 }).toBe(1);
    const told = github.comments(102)[0]?.body ?? "";
    const storiesOf = (change: Change) =>
      [third?.body ?? "", told].join("\n").split(presentationRegionMarkers(idOf(change)).start)
        .length - 1;
    expect(Array.from(third?.body ?? "").length).toBeLessThanOrEqual(
      presentationBodyLimit("github.com"),
    );
    expect(third?.body).toContain(`- ${ownBatchTitle("axis")}\n- ${ownBatchTitle("grid")}`);
    expect(third?.body).toContain(BATCH_DESCRIPTION_WORDS.continued(1));
    expect(third?.body).toContain(ownBatchChanged("axis"));
    expect(told.startsWith(BATCH_STORIES_MARKER)).toBe(true);
    expect(told).toContain(ownBatchChanged("grid"));
    expect([storiesOf("axis"), storiesOf("grid")]).toEqual([1, 1]);
    github.setPullChecks(102, FAILED);
    await expect
      .poll(async () => (await meterlab())?.batch?.open?.hold, { timeout: 30_000 })
      .toMatchObject({ reason: "checks", checks: ["unit-tests"], notRun: ["journeys"] });
    await expect
      .poll(
        () =>
          launched.mockProvider?.requestBodies().some((body) => body.includes(BATCH_HELD_OPENING)),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(github.merges()).toHaveLength(2);

    // Settings shows the held batch under the project, and every control answers to keys.
    await pressKey(page.getByRole("button", { name: "Settings" }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Projects" }), "Enter");
    await pressKey(projectLine(page, "repo-meterlab").getByRole("button"), "Enter");
    const row = projectSettings(page, "repo-meterlab");
    await expect(row.getByText(BATCH_OWN_WORDS.note)).toBeVisible();
    const panel = row.locator('[data-batch-hold="repo-meterlab"]');
    await expect(panel.getByText(BATCH_HOLD_WORDS.title)).toBeVisible();
    // The summary names the failed check and how many changes wait; its clock time is the hold's own.
    const [, afterTime = ""] = BATCH_HOLD_WORDS.checks("\u0000", ["unit-tests"], 2).split("\u0000");
    await expect(panel.locator("[data-batch-hold-summary]")).toContainText(afterTime);
    await expect(panel.getByRole("button", { name: BATCH_HOLD_WORDS.tryAgain })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: BATCH_HOLD_WORDS.open(changeNumberLabel("github", 102)) }),
    ).toBeVisible();
    // The panel sits under the project's other details: bring it and its choice into the window.
    const inView = () => panel.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await inView();
    await heroShot(launched.app, page, {
      region: panel,
      anchors: [row.getByRole("radiogroup", { name: "Where changes go" })],
      name: "batches-of-your-own",
      ready: inView,
    });

    const reason = "its axis file breaks the unit tests";
    const sendBack = panel.getByRole("button", { name: BATCH_HOLD_WORDS.sendBack });
    // Nothing chosen yet: the panel says what it needs and sends nothing.
    await pressKey(sendBack, "Enter");
    await expect(panel.getByText(BATCH_HOLD_WORDS.needsChange)).toBeVisible();
    await pressKey(panel.getByRole("checkbox", { name: ownBatchTitle("axis") }), "Space");
    const why = panel.getByRole("textbox", {
      name: BATCH_HOLD_WORDS.reason(ownBatchTitle("axis")),
    });
    await focusOn(why);
    await typeInto(why, reason);
    await pressKey(sendBack, "Enter");

    // INF-5097: the project's batch record keeps the one send-back, with the check that never ran.
    await expect
      .poll(
        async () =>
          (await meterlab())?.batch?.sentBack?.filter((entry) => entry.taskId === idOf("axis")),
        { timeout: 30_000 },
      )
      .toMatchObject([{ reason, failed: ["unit-tests"], notRun: ["journeys"] }]);
    // Its crewmate reads the reason, that this is its first send-back, the check that never ran,
    // the checks to run before showing it again and how to declare the repair under the kept
    // approval. The scripted repair waits here, so the approval is read before it moves.
    // The crewmate's first batch-sent-back message, read from the provider's user messages.
    const wake = () =>
      (launched.mockProvider?.requestBodies() ?? [])
        .flatMap((body) => providerMessages(body))
        .find(
          (message) =>
            message.role === "user" &&
            message.text.includes(BATCH_SENT_BACK_WORDS.opening) &&
            message.text.includes(reason),
        )?.text;
    await expect
      .poll(() => launched.mockProvider?.heldThreadAnswers(), { timeout: 30_000 })
      .toBe(1);
    const sentBack = wake();
    expect(sentBack).toBeDefined();
    for (const words of [
      reason,
      BATCH_SENT_BACK_WORDS.once,
      BATCH_SENT_BACK_WORDS.neverRan(["journeys"]),
      BATCH_SENT_BACK_WORDS.reproof,
      COVERED_BATCH_STEP,
    ]) {
      expect(sentBack).toContain(words);
    }
    // Keep the crewmate's message as the provider received it, so a reader sees the words whole.
    await test.info().attach("batch-sent-back request", {
      body: sentBack ?? "",
      contentType: "text/plain",
    });
    // The sent-back change keeps its approval while its repair waits; its task stays open.
    const sentBackVersion = saved("axis")?.delivery?.mergeAuthorization?.approvedHead ?? "";
    expect(saved("axis")?.delivery?.mergeAuthorization?.status).toBe("standing");
    expect(saved("axis")?.closedReason ?? null).toBeNull();
    launched.mockProvider?.releaseThreadAnswer();
    // The rest of the batch is combined again on the same pull request, and the hold ends.
    await expect
      .poll(() => github.pulls()[2], { timeout: 30_000 })
      .toMatchObject({ number: 102, title: ownBatchTitle("grid"), merged: false });
    // Its description is the grid change's own story again, and the app's comment that carried
    // a story is gone, so nothing on the pull request still tells the axis change's.
    await expect.poll(() => github.comments(102), { timeout: 30_000 }).toEqual([]);
    expect(github.pulls()[2]?.body).toContain(ownBatchChanged("grid"));
    expect(github.pulls()[2]?.body).not.toContain(ownBatchChanged("axis"));
    await expect(panel).toHaveCount(0, { timeout: 30_000 });
    github.setPullChecks(102, PASSED);
    await expect
      .poll(() => github.merges()[2], { timeout: 30_000 })
      .toMatchObject({ number: 102, method: "squash", title: ownBatchTitle("grid") });
    await expect
      .poll(() => saved("grid")?.closedReason ?? null, { timeout: 30_000 })
      .toBe("merged");
    const subjects = git("log", "--format=%s", "main").split("\n");
    expect(subjects[0]).toBe(ownBatchTitle("grid"));
    expect(subjects).not.toContain(ownBatchTitle("axis"));
    expect(github.pulls()).toHaveLength(3);

    // INF-5097: the axis crewmate repairs its change in a new version and declares it changed
    // work, which ends the kept approval and brings a new merge card to the captain. Its Batch
    // check says the change was sent back once, and its details give the reason, by keys.
    await expect.poll(cardTitles, { timeout: 60_000 }).toContain(ownBatchTitle("axis"));
    expect(saved("axis")?.delivery?.mergeAuthorization?.status).not.toBe("standing");
    expect(git("show", `refs/heads/${saved("axis")?.branch}:axis.txt`)).toBe(
      ownBatchRepaired("axis"),
    );
    // Settings is still open on the project's page from the send-back: go back to the Projects
    // list by keys, then close Settings from the project's line so the card stack shows.
    await pressKey(page.locator("[data-project-back]"), "Enter");
    const meterlabLine = projectLine(page, "repo-meterlab").getByRole("button");
    await expect(meterlabLine).toBeVisible();
    await expect(page.locator("[data-project-back]")).toHaveCount(0);
    await pressKey(meterlabLine, "Escape");
    await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
      "data-screen-label",
      "Settings",
    );
    await showCard(page, ownBatchTitle("axis"));
    const axisStrip = factsStrip(cardBody(page, ownBatchTitle("axis")));
    await expect(axisStrip.batch).toHaveText(BATCH_CHECK_WORDS.sentBack(1), { timeout: 30_000 });
    const history = axisStrip.strip.locator('[data-history="batch"]');
    await expect(history.locator("summary")).toHaveText(BATCH_CHECK_WORDS.sentBackSummary(1));
    await expect(history.getByText(reason)).toBeHidden();
    await pressKey(history.locator("summary"), "Enter");
    await expect(history).toHaveAttribute("open", "");
    await expect(history.getByText(reason)).toBeVisible();
    await expect(
      history.getByRole("link", { name: changeNumberLabel("github", 102) }),
    ).toBeVisible();
    // Approved again, the repaired version merges in a batch of its own, never the version sent back.
    await approve("axis");
    await expect.poll(() => github.pulls().length, { timeout: 30_000 }).toBe(4);
    expect(github.pulls()[3]).toMatchObject({ number: 103, title: ownBatchTitle("axis") });
    github.setPullChecks(103, PASSED);
    await expect
      .poll(() => saved("axis")?.closedReason ?? null, { timeout: 30_000 })
      .toBe("merged");
    expect(git("log", "--format=%s", "-1", "main")).toBe(ownBatchTitle("axis"));
    expect(git("show", "main:axis.txt")).toBe(ownBatchRepaired("axis"));
    expect(saved("axis")?.delivery?.mergeAuthorization?.approvedHead).not.toBe(sentBackVersion);
  } finally {
    await launched.close();
    await github.close();
  }
});
