import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { MERGE_LINE_MARK, mergedWords } from "../../src/core/orchestrator/settleWords";
import { openDatabase } from "../../src/core/storage/db";
import { MERGE_NOT_NOW_WORDS, MERGE_WORDS, RIGOR_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { AUTONOMY_ASK_MARKER, MERGE_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { feedLine, putInLine, taskKey } from "./rails";
import {
  AUTONOMY_ASKS_FIRST_MARKER,
  AUTONOMY_PROMPT_MARKER,
  autonomy,
  MOCK_AUTONOMY_CARD_TITLE,
} from "./scenarios/autonomy";
import { factsStrip, shownCard } from "./stack";

/**
 * Autonomy as a repository default with a per-task ask, and the hold the
 * HOST places on it (contract v3.9; captain ruling of 2026-09-20: "this
 * should actually be the same - repo default, per-task ask allowed").
 *
 * Until v3.9 the flag was enforced by the Firstmate's prompt alone, so a
 * Firstmate that reached for `settle_task merge-pr` on an ask-first
 * repository merged. What this spec proves end to end is the difference:
 * on the SAME repository, with the same scripted Firstmate turn, a task the
 * captain said nothing about is held - nothing merges, the merge card
 * stays on the stack with its own "Merge the pull request" button - and a task he said
 * "merge it yourself when it's green" about merges.
 * INF-2744 (the captain's plan answer, "autonomy control should all be
 * consistent"): every merge is asked on the same merge card, and with
 * autonomy on the app merges from that card itself as it goes up, with no
 * first mate turn, unless the crewmate declared that a standing direction
 * leaves this merge to the captain. The local GitHub
 * stand-in (`./githubStub.ts`) records every merge the app asks for through
 * its own sign-in, so "nothing merged" is read off the forge, not off prose.
 * Each test starts from its own fresh app, repository and stand-in.
 */

const REPO_NAME = "meterlab";
const HELD_TITLE = `${REPO_NAME} ${AUTONOMY_PROMPT_MARKER}`;
const ASKED_TITLE = `${REPO_NAME} ${AUTONOMY_PROMPT_MARKER}, ${AUTONOMY_ASK_MARKER}`;
const ASKS_FIRST_TITLE = `${REPO_NAME} ${AUTONOMY_ASKS_FIRST_MARKER}, ${AUTONOMY_ASK_MARKER}`;

const CHANGE = {
  number: 61,
  title: "fix: make the meter read on time",
  body: "The meter reads on the first paint.",
};

let launched: LaunchedApp;
let github: GitHubStub;
let repoDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();

test.beforeEach(async () => {
  const userDataDir = scratchDir("infinitary-autonomy-");
  repoDir = seedRepo(userDataDir).repoDir;
  github = await startGitHubStub();
  github.servePull(CHANGE);
  // The change's head is the task branch's own commit: the crewmate's save point.
  github.headOf((branch) => git("rev-parse", `refs/heads/${branch}`));
  seedGitHubSignIn(userDataDir);
  // Direct-pr, autonomy OFF (0), rigor quick: the repository asks before
  // landing, which is every repository's default on setup.
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repoDir,
    name: REPO_NAME,
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  launched = await launchApp({
    scenarios: [autonomy],
    withMockProvider: true,
    userDataDir,
    env: github.env,
  });
});

test.afterEach(async () => {
  await launched.close();
  await github.close();
});

/**
 * The head the app checked for a task's change, once it has, after proving
 * it is the commit on the task's own branch: the one head a merge may use.
 */
async function checkedHead(title: string): Promise<string> {
  const detail = async () => {
    const board = await launched.page.evaluate(() => window.infinitary.tasks.board());
    const row = board.tasks.find((task) => task.title === title);
    return row ? launched.page.evaluate((id) => window.infinitary.tasks.detail(id), row.id) : null;
  };
  await expect
    .poll(async () => (await detail())?.delivery?.headSha, { timeout: 15_000 })
    .toMatch(/^[0-9a-f]{40}$/);
  const task = await detail();
  const head = task?.delivery?.headSha as string;
  expect(git("rev-parse", `refs/heads/${task?.repo?.branch}`)).toBe(head);
  return head;
}

const squashAt = (sha: string) => [
  { number: CHANGE.number, sha, method: "squash", title: CHANGE.title, message: CHANGE.body },
];

async function send(text: string): Promise<void> {
  const input = promptInput(launched.page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

test("the host holds a Firstmate merge where autonomy is off, and the captain's card keeps the decision", async () => {
  const { page } = launched;
  await send(`${SPAWN_PROMPT_MARKER} ${HELD_TITLE}`);
  const cardTitle = MOCK_AUTONOMY_CARD_TITLE(HELD_TITLE);
  await expect(shownCard(page, cardTitle)).toBeVisible({ timeout: 30_000 });

  // The strip gives the task's care without the old autonomy cell; the
  // captain still gets the actual merge decision in the footer.
  const frame = cardBody(page, cardTitle);
  await expect(factsStrip(frame).care).toHaveText(RIGOR_WORDS.quick);
  await expect(page.getByRole("button", { name: MERGE_WORDS["merge-pr"] })).toBeVisible();
  // INF-2744: the merge closes the task and drops its own working copy, so
  // Discard sits beside it, and Not now does not.
  const card = shownCard(page, cardTitle);
  await expect(card.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: MERGE_NOT_NOW_WORDS, exact: true })).toHaveCount(0);

  // The Firstmate reaches for the merge, and the host refuses. The refusal
  // is a tool result, not a feed line - there is nothing to announce, since
  // the decision it hands back is the button already on screen.
  await send(`${MERGE_PROMPT_MARKER}${HELD_TITLE}`);
  await expect(feedLine(page, new RegExp(MERGE_PROMPT_MARKER))).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        return board.tasks.find((task) => task.title === HELD_TITLE)?.status;
      },
      { timeout: 15_000 },
    )
    .toBe("active");
  expect(github.merges()).toEqual([]);
  await expect(shownCard(page, cardTitle)).toBeVisible();
  await expect(page.getByRole("button", { name: MERGE_WORDS["merge-pr"] })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("autonomy-off-held-card.png") });

  const head = await checkedHead(HELD_TITLE);
  await page.getByRole("button", { name: MERGE_WORDS["merge-pr"] }).click();
  await expect.poll(() => github.merges(), { timeout: 30_000 }).toEqual(squashAt(head));
  await expect
    .poll(async () => {
      const board = await page.evaluate(() => window.infinitary.tasks.board());
      return board.tasks.find((task) => task.title === HELD_TITLE)?.status;
    })
    .toBe("done");
});

async function taskDetail(title: string) {
  const page = launched.page;
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  const task = board.tasks.find((row) => row.title === title);
  return task ? page.evaluate((id) => window.infinitary.tasks.detail(id), task.id) : null;
}

// INF-2744: with autonomy on, the app merges from the crewmate's merge card
// as it goes up - no first mate turn and no click - and the card then shows
// once, without buttons, saying it merged on its own.
test("a task the captain said to merge on green merges from its own merge card, on the same ask-first repository (INF-2744)", async () => {
  const { page } = launched;
  await send(`${SPAWN_PROMPT_MARKER} ${ASKED_TITLE}`);
  const cardTitle = MOCK_AUTONOMY_CARD_TITLE(ASKED_TITLE);
  // Nothing more is asked of the first mate: the merge goes at the checked
  // head. The app merges as soon as the checks pass and the close drops the
  // task's branch, so the head is read from the task's record, which keeps it.
  await expect.poll(() => github.merges().length, { timeout: 30_000 }).toBe(1);
  await expect
    .poll(() => taskDetail(ASKED_TITLE), { timeout: 15_000 })
    .toMatchObject({ status: "done", closedReason: "merged" });
  const head = (await taskDetail(ASKED_TITLE))?.delivery?.headSha as string;
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  expect(github.merges()).toEqual(squashAt(head));
  const card = shownCard(page, cardTitle);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const frame = cardBody(page, cardTitle);
  await expect(factsStrip(frame).care).toHaveText(RIGOR_WORDS.quick);
  await expect(frame.locator(`[${MERGE_LINE_MARK}]`)).toContainText(mergedWords("", true).trim());
  await expect(card.getByRole("button", { name: MERGE_WORDS["merge-pr"] })).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.infinitary.cards.list())).find(
      (entry) => entry.title === cardTitle,
    )?.actions,
  ).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("autonomy-on-card.png") });
});

// INF-2744: a crewmate whose standing direction leaves the merge to the
// captain declares asks_first, and the merge card keeps its buttons on a
// task that otherwise merges on its own.
test("a merge card that asks first waits for the captain's click on a task that merges on its own (INF-2744)", async () => {
  const { page } = launched;
  await send(`${SPAWN_PROMPT_MARKER} ${ASKS_FIRST_TITLE}`);
  const cardTitle = MOCK_AUTONOMY_CARD_TITLE(ASKS_FIRST_TITLE);
  const card = shownCard(page, cardTitle);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const head = await checkedHead(ASKS_FIRST_TITLE);
  const button = card.getByRole("button", { name: MERGE_WORDS["merge-pr"] });
  await expect(button).toBeVisible();
  expect(github.merges()).toEqual([]);
  expect(await taskDetail(ASKS_FIRST_TITLE)).toMatchObject({ status: "active" });
  await page.screenshot({ path: test.info().outputPath("autonomy-asks-first-card.png") });
  await button.click();
  await expect.poll(() => github.merges(), { timeout: 30_000 }).toEqual(squashAt(head));
  await expect
    .poll(() => taskDetail(ASKS_FIRST_TITLE), { timeout: 15_000 })
    .toMatchObject({ status: "done", closedReason: "merged" });
});

test("a pull request the captain merged on GitHub himself closes its task as merged, with nothing merged twice", async () => {
  const { page } = launched;
  await send(`${SPAWN_PROMPT_MARKER} ${HELD_TITLE}`);
  const cardTitle = MOCK_AUTONOMY_CARD_TITLE(HELD_TITLE);
  await expect(shownCard(page, cardTitle)).toBeVisible({ timeout: 30_000 });
  await checkedHead(HELD_TITLE);

  // The captain merges the change on GitHub's own page instead of the card:
  // GitHub no longer lists it among the branch's open pull requests.
  github.mergeByHand(CHANGE.number);

  // The Firstmate's settle on this ask-first repository is not held: there
  // is no merge left to hold, and the task closes as merged.
  await send(`${MERGE_PROMPT_MARKER}${HELD_TITLE}`);
  await expect(putInLine(page, await taskKey(page, HELD_TITLE))).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        const task = board.tasks.find((row) => row.title === HELD_TITLE);
        return task ? page.evaluate((id) => window.infinitary.tasks.detail(id), task.id) : null;
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ status: "done", closedReason: "merged" });
  expect(github.merges()).toEqual([]);
  expect(github.mergeRequests()).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("merged-by-hand-closed.png") });
});
