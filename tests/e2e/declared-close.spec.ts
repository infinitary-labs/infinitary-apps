import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { presentationCommitMessage } from "../../src/core/forge/presentation";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import { MERGE_CLOSES_WORDS } from "../../src/shared/cards";
import { MERGE_WORDS, PULL_REQUEST_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import {
  FM_SYSTEM_MARKER,
  MERGE_PROMPT_MARKER,
  type Scenario,
  SPAWN_PROMPT_MARKER,
  STEER_PROMPT_MARKER,
  sinceLastUser,
} from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { expectRecordBody, hideRecord, recordCard, recordDrawings, taskKeyLinks } from "./rails";
import { readSavedData } from "./savedData";
import {
  DECLARED_CLOSE_MARKER,
  type DeclaredCloseShape,
  declaredClose,
  FINISH_CARD_TITLE,
  OWN_PULL,
  RELEASE_CARD_TITLE,
  RELEASE_PULL,
  STALE_STEER,
} from "./scenarios/declaredClose";
import {
  FIRSTMATE_MERGE_ASK,
  FIRSTMATE_MERGE_CARD,
  firstmateStoryMerge,
  STORY_MERGE_MARKER,
  STORY_MERGE_STORY,
  STORY_MERGE_TITLE,
} from "./scenarios/firstmateStoryMerge";
import {
  cardReply,
  cardSurface,
  completionAction,
  expectNoCard,
  factsStrip,
  shownCard,
} from "./stack";
import { pressKey } from "./windowKeys";

/**
 * INF-2490, the declared close (the captain's answers to INF-2489): a task
 * may merge several pull requests, each one of its changes. A request_merge
 * card's merge continues the task; the completion card's merge is the
 * finishing change and closes it as merged, removing its working copy; and
 * the first mate's merge of a change already merged closes it as merged with
 * autonomy on too. Each merge card says which, in the app's own line.
 * Review INF-2546 adds the cases around it: a finishing card shown for one
 * pull request merges nothing once another is current, a remaining pull
 * request GitHub cannot read keeps the task open, and the first mate
 * finishes a task whose current change is another branch's pull request.
 *
 * GitHub is the local stand-in (`./githubStub.ts`); the crewmate is the
 * scripted `declaredClose` scenario, in the shape each test names. Each
 * test needs desktop Electron and local git; none reaches a real sign-in
 * or a shared pull request.
 */

const MERGE = MERGE_WORDS["merge-pr"];
const PROJECT = "meterlab";
const TASK_TITLE = `${PROJECT} ${DECLARED_CLOSE_MARKER}`;
/** The captain asks the first mate to merge the task. */
const MERGE_PROMPT = `${MERGE_PROMPT_MARKER}${TASK_TITLE}`;
/** GitHub's answer while it cannot read a pull request (INF-2546 R8). */
const READ_FAILURE = { status: 502, message: "Server Error" };
/** release-please's head on its own branch, which the task never checks out. */
const RELEASE_HEAD = "4fc9140d92b3a9d25937dec0ff4f9754fdc8c8e4";

async function arrange(shape: DeclaredCloseShape | Scenario, options: { autonomy?: boolean } = {}) {
  const userDataDir = scratchDir("infinitary-declared-close-");
  const repo = seedRepo(userDataDir);
  const github = await startGitHubStub();
  github.serveNumbered({
    number: RELEASE_PULL.number,
    branch: RELEASE_PULL.branch,
    title: "chore(main): release 0.1.8",
    headSha: RELEASE_HEAD,
  });
  github.headOf((branch) =>
    branch === RELEASE_PULL.branch ? RELEASE_HEAD : repo.branchHead(branch),
  );
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repo.repoDir,
    name: PROJECT,
    setupKind: "clone",
    origin: `https://github.com/o/${PROJECT}.git`,
    runsOn: null,
    delivery: "direct-pr",
    ...(options.autonomy ? { autonomy: true } : {}),
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [typeof shape === "string" ? declaredClose(shape) : shape],
    userDataDir,
    env: github.env,
  });
  const close = async () => {
    await launched.close();
    await github.close();
  };
  return { launched, page: launched.page, github, repo, close, userDataDir };
}

async function send(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** The task the card with this title belongs to, as the core lists it. */
async function cardTask(page: Page, title: string): Promise<string> {
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  const taskId = cards.find((card) => card.title === title)?.taskId;
  if (!taskId) throw new Error(`No task card titled "${title}"`);
  return taskId;
}

function detail(page: Page, taskId: string) {
  return page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
}

/** The branches the project's working copies are on, from git itself. */
function workingCopyBranches(repoDir: string): string[] {
  return execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/"))
    .map((line) => line.slice("branch refs/heads/".length));
}

/** The numbers GitHub merged, in order. */
const mergedNumbers = (github: { merges: () => { number: number }[] }) =>
  github.merges().map((merge) => merge.number);

/**
 * How many first mate steps answered the captain's merge prompt after its
 * tool's result came back: the settle's outcome reached the first mate.
 */
const settleAnswers = (bodies: string[]) =>
  bodies.filter((body) => {
    if (!body.includes(FM_SYSTEM_MARKER)) return false;
    const { user, results } = sinceLastUser(body);
    return user.includes(MERGE_PROMPT) && results.length > 0;
  }).length;

test("a task merges a continuing pull request, then finishes with its own, and closes only on the finishing merge", async () => {
  const { page, github, repo, close } = await arrange("two-pulls");
  try {
    await send(page, `${SPAWN_PROMPT_MARKER} ${TASK_TITLE}`);
    const release = shownCard(page, RELEASE_CARD_TITLE);
    await expect(release).toBeVisible({ timeout: 30_000 });
    await expect(factsStrip(cardBody(page, RELEASE_CARD_TITLE)).mergeLine).toHaveText(
      MERGE_CLOSES_WORDS.continues,
    );
    const taskId = await cardTask(page, RELEASE_CARD_TITLE);
    const branch = (await detail(page, taskId))?.repo?.branch;
    if (!branch) throw new Error("The task has no branch");
    expect(workingCopyBranches(repo.repoDir)).toContain(branch);
    // The task's own pull request is open on its branch.
    github.serveNumbered({
      number: OWN_PULL,
      branch,
      title: "fix: the meter reads on the first paint",
      headSha: repo.branchHead(branch),
    });

    await pressKey(release.getByRole("button", { name: MERGE, exact: true }), "Enter");
    await expectNoCard(page, RELEASE_CARD_TITLE);
    await expect
      .poll(() => mergedNumbers(github), { timeout: 20_000 })
      .toEqual([RELEASE_PULL.number]);
    // The continuing merge leaves the task open with its working copy.
    expect((await detail(page, taskId))?.closedReason ?? null).toBeNull();
    expect(workingCopyBranches(repo.repoDir)).toContain(branch);

    // Woken once, the crewmate offers its own pull request as the finishing change.
    const finish = shownCard(page, FINISH_CARD_TITLE);
    await expect(finish).toBeVisible({ timeout: 30_000 });
    const facts = factsStrip(cardBody(page, FINISH_CARD_TITLE));
    await expect(facts.mergeLine).toHaveText(MERGE_CLOSES_WORDS.closes);
    await expect(facts.change).toContainText(`#${OWN_PULL}`);
    await regionShot(finish, test.info().outputPath("finishing-card.png"));

    // Round two (the captain's answer): the record's Info lists both pull
    // requests, the merged release and the one whose merge closes the task.
    await pressKey(taskKeyLinks(cardSurface(page)).first(), "Enter");
    await expect(recordCard(page)).toBeVisible();
    await expectRecordBody(page);
    const pull = (number: number) =>
      recordCard(page).locator(`[data-task-pull-request="${number}"]`);
    await expect(recordCard(page).locator("[data-task-pull-request]")).toHaveCount(2);
    await expect(pull(RELEASE_PULL.number)).toContainText(PULL_REQUEST_WORDS.merged);
    await expect(pull(RELEASE_PULL.number)).not.toHaveAttribute("data-pull-request-closes");
    await expect(pull(OWN_PULL)).toContainText(PULL_REQUEST_WORDS.closes);
    await expect(pull(OWN_PULL)).toHaveAttribute("data-pull-request-closes", "");
    await regionShot(
      recordCard(page).locator('[data-task-fact="pull-requests"]').locator(".."),
      test.info().outputPath("pull-requests.png"),
    );
    await pressKey(hideRecord(page), "Enter");
    await expect(recordDrawings(page, taskId)).toHaveCount(0);

    await pressKey(finish.getByRole("button", { name: MERGE, exact: true }), "Enter");
    await expect
      .poll(() => mergedNumbers(github), { timeout: 20_000 })
      .toEqual([RELEASE_PULL.number, OWN_PULL]);
    await expect
      .poll(() => detail(page, taskId), { timeout: 20_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    await expect.poll(() => workingCopyBranches(repo.repoDir)).not.toContain(branch);
  } finally {
    await close();
  }
});

test("with autonomy on, a request_merge merges the release and the first mate's merge closes the task as merged (RUU-35)", async () => {
  const { page, github, repo, close } = await arrange("release", { autonomy: true });
  try {
    await send(page, `${SPAWN_PROMPT_MARKER} ${TASK_TITLE}`);
    const release = shownCard(page, RELEASE_CARD_TITLE);
    await expect(release).toBeVisible({ timeout: 30_000 });
    await expect(factsStrip(cardBody(page, RELEASE_CARD_TITLE)).mergeLine).toHaveText(
      MERGE_CLOSES_WORDS.continues,
    );
    const taskId = await cardTask(page, RELEASE_CARD_TITLE);
    const branch = (await detail(page, taskId))?.repo?.branch;
    if (!branch) throw new Error("The task has no branch");

    await pressKey(release.getByRole("button", { name: MERGE, exact: true }), "Enter");
    await expectNoCard(page, RELEASE_CARD_TITLE);
    await expect
      .poll(() => mergedNumbers(github), { timeout: 20_000 })
      .toEqual([RELEASE_PULL.number]);
    expect((await detail(page, taskId))?.closedReason ?? null).toBeNull();

    // The first mate's merge of the already-merged release sends nothing and closes the task.
    await send(page, `${MERGE_PROMPT_MARKER}${TASK_TITLE}`);
    await expect
      .poll(() => detail(page, taskId), { timeout: 30_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    expect(mergedNumbers(github)).toEqual([RELEASE_PULL.number]);
    await expect.poll(() => workingCopyBranches(repo.repoDir)).not.toContain(branch);
  } finally {
    await close();
  }
});

test("a completion card whose finishing change is another branch's pull request merges it and closes the task as merged (INF-1539)", async () => {
  const { page, github, repo, close } = await arrange("taken-over");
  try {
    await send(page, `${SPAWN_PROMPT_MARKER} ${TASK_TITLE}`);
    const finish = shownCard(page, FINISH_CARD_TITLE);
    await expect(finish).toBeVisible({ timeout: 30_000 });
    const facts = factsStrip(cardBody(page, FINISH_CARD_TITLE));
    await expect(facts.mergeLine).toHaveText(MERGE_CLOSES_WORDS.closes);
    await expect(facts.change).toContainText(`#${RELEASE_PULL.number}`);
    const taskId = await cardTask(page, FINISH_CARD_TITLE);
    const branch = (await detail(page, taskId))?.repo?.branch;
    if (!branch) throw new Error("The task has no branch");

    await pressKey(finish.getByRole("button", { name: MERGE, exact: true }), "Enter");
    await expect
      .poll(() => mergedNumbers(github), { timeout: 20_000 })
      .toEqual([RELEASE_PULL.number]);
    await expect
      .poll(() => detail(page, taskId), { timeout: 20_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    await expect.poll(() => workingCopyBranches(repo.repoDir)).not.toContain(branch);
  } finally {
    await close();
  }
});

test("a finishing card shown for one pull request merges nothing once another is current, an unreadable one keeps the task open, and it closes once every one merged (INF-2546)", async () => {
  const { launched, page, github, repo, close } = await arrange("stale");
  const bodies = () => launched.mockProvider?.requestBodies() ?? [];
  try {
    // The finishing card goes up for the release, the task's current change.
    await send(page, `${SPAWN_PROMPT_MARKER} ${TASK_TITLE}`);
    const finish = shownCard(page, FINISH_CARD_TITLE);
    await expect(finish).toBeVisible({ timeout: 30_000 });
    const facts = factsStrip(cardBody(page, FINISH_CARD_TITLE));
    await expect(facts.change).toContainText(`#${RELEASE_PULL.number}`);
    const taskId = await cardTask(page, FINISH_CARD_TITLE);
    const branch = (await detail(page, taskId))?.repo?.branch;
    if (!branch) throw new Error("The task has no branch");
    github.serveNumbered({
      number: OWN_PULL,
      branch,
      title: "fix: the meter reads on the first paint",
      headSha: repo.branchHead(branch),
    });

    // A stale merge target (R1): steered, the crewmate checks the task's own
    // pull request, the current change from then on, while the card stays up.
    await send(page, `${STEER_PROMPT_MARKER}${TASK_TITLE}: ${STALE_STEER}`);
    await expect
      .poll(async () => (await detail(page, taskId))?.delivery?.prNumber, { timeout: 30_000 })
      .toBe(OWN_PULL);
    await pressKey(finish.getByRole("button", { name: MERGE, exact: true }), "Enter");
    // The click is refused on the card it was shown on, and nothing merged.
    await expect(finish.getByRole("alert")).toBeVisible({ timeout: 20_000 });
    expect(mergedNumbers(github)).toEqual([]);
    expect((await detail(page, taskId))?.closedReason ?? null).toBeNull();
    await regionShot(finish, test.info().outputPath("stale-card-refused.png"));

    // The record lists both, and neither closes the task: the open
    // finishing card was shown for a change that is no longer current (R5).
    await pressKey(taskKeyLinks(cardSurface(page)).first(), "Enter");
    await expect(recordCard(page)).toBeVisible();
    await expectRecordBody(page);
    await expect(recordCard(page).locator("[data-task-pull-request]")).toHaveCount(2);
    await expect(recordCard(page).locator("[data-pull-request-closes]")).toHaveCount(0);
    await regionShot(
      recordCard(page).locator('[data-task-fact="pull-requests"]').locator(".."),
      test.info().outputPath("stale-pull-requests.png"),
    );
    await pressKey(hideRecord(page), "Enter");
    await expect(recordDrawings(page, taskId)).toHaveCount(0);

    // An unreadable remaining pull request (R8): the own pull request merged
    // on GitHub's page, the release cannot be read, so the first mate's
    // merge closes nothing.
    github.mergeByHand(OWN_PULL);
    github.setPullReadFailure(RELEASE_PULL.number, READ_FAILURE);
    const before = settleAnswers(bodies());
    await send(page, MERGE_PROMPT);
    await expect.poll(() => settleAnswers(bodies()), { timeout: 30_000 }).toBeGreaterThan(before);
    expect(await detail(page, taskId)).toMatchObject({ status: "active" });
    expect((await detail(page, taskId))?.closedReason ?? null).toBeNull();
    expect(workingCopyBranches(repo.repoDir)).toContain(branch);

    // The outside-merge finishing path: once the release reads merged too,
    // the first mate's merge sends nothing and closes the task as merged.
    github.setPullReadFailure(RELEASE_PULL.number, undefined);
    github.mergeByHand(RELEASE_PULL.number);
    await send(page, MERGE_PROMPT);
    await expect
      .poll(() => detail(page, taskId), { timeout: 30_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    expect(mergedNumbers(github)).toEqual([]);
    await expect.poll(() => workingCopyBranches(repo.repoDir)).not.toContain(branch);
  } finally {
    await close();
  }
});

test("with autonomy on, the first mate merges the finishing change on another branch and closes the task as merged (INF-2546)", async () => {
  const { page, github, repo, close } = await arrange("taken-over", { autonomy: true });
  try {
    await send(page, `${SPAWN_PROMPT_MARKER} ${TASK_TITLE}`);
    // The crewmate names the release as the task's change and offers it as
    // the finishing one.
    const task = async () =>
      (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (row) => row.title === TASK_TITLE,
      )?.id;
    await expect.poll(task, { timeout: 30_000 }).toBeTruthy();
    const taskId = (await task()) as string;
    await expect
      .poll(async () => (await detail(page, taskId))?.delivery?.prNumber, { timeout: 30_000 })
      .toBe(RELEASE_PULL.number);
    const branch = (await detail(page, taskId))?.repo?.branch;
    if (!branch) throw new Error("The task has no branch");

    await send(page, MERGE_PROMPT);
    await expect
      .poll(() => mergedNumbers(github), { timeout: 30_000 })
      .toEqual([RELEASE_PULL.number]);
    await expect
      .poll(() => detail(page, taskId), { timeout: 20_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    await expect.poll(() => workingCopyBranches(repo.repoDir)).not.toContain(branch);
  } finally {
    await close();
  }
});

/**
 * INF-2546 R11, the captain's q8 "include first-mate-merge": the first mate's
 * own merge card on a task whose pull request carries its published story.
 * The captain's click goes through the app's merge, which checks the story
 * where the project lives, and GitHub receives one squash at the published
 * version with the story as its message; the task closes as merged.
 */
test("the first mate's merge card on a published story merges at the published version and closes the task (INF-2546)", async () => {
  const { page, github, repo, close, userDataDir } = await arrange(firstmateStoryMerge);
  const title = `${PROJECT} ${STORY_MERGE_MARKER}`;
  try {
    await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
    // The crewmate published its story and put its completion card up.
    await expect(shownCard(page, STORY_MERGE_TITLE)).toBeVisible({ timeout: 60_000 });
    const taskId = await cardTask(page, STORY_MERGE_TITLE);
    const saved = () =>
      readSavedData(userDataDir, (db) =>
        new TaskStore(db).list().find((task) => task.id === taskId),
      );
    const task = saved();
    const branch = task?.branch;
    if (!branch) throw new Error("The task has no branch");
    const published = task?.delivery?.presentation?.published;
    const head = repo.branchHead(branch);
    expect(published).toMatchObject({ head, number: task?.delivery?.prNumber });
    const number = published?.number as number;

    // The captain asks under that card for the first mate's own. Putting a
    // decision aside keeps it open (INF-1879), so the crewmate withdraws its
    // card and hands the words to the first mate, which puts up its own.
    await cardReply(page).field.fill(`${FIRSTMATE_MERGE_ASK}${title}`);
    await pressKey(cardReply(page).field, "Enter");
    await expectNoCard(page, STORY_MERGE_TITLE, { timeout: 30_000 });
    const card = shownCard(page, FIRSTMATE_MERGE_CARD);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(factsStrip(cardBody(page, FIRSTMATE_MERGE_CARD)).mergeLine).toHaveText(
      MERGE_CLOSES_WORDS.closes,
    );
    expect(github.merges()).toEqual([]);
    await regionShot(card, test.info().outputPath("firstmate-merge-card.png"));

    await pressKey(await completionAction(page, FIRSTMATE_MERGE_CARD), "Enter");
    await expect
      .poll(() => github.merges(), { timeout: 30_000 })
      .toEqual([
        {
          number,
          sha: head,
          method: "squash",
          title: STORY_MERGE_TITLE,
          message: presentationCommitMessage(STORY_MERGE_STORY),
        },
      ]);
    await expect
      .poll(() => detail(page, taskId), { timeout: 20_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    writeFileSync(
      test.info().outputPath("firstmate-story-merge.json"),
      JSON.stringify(
        { published, head, merges: github.merges(), status: saved()?.status },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
});
