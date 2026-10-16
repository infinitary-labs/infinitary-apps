import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { CARE_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import {
  AUTONOMY_ASK_MARKER,
  AUTONOMY_PROMPT_MARKER,
  MERGE_PROMPT_MARKER,
  MOCK_AUTONOMY_CARD_TITLE,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { feedLine, putInLine, taskKey } from "./rails";
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
 * captain said nothing about is held - nothing merges, the completion card
 * stays on the stack with its own "Merge the pull request" button - and a task he said
 * "merge it yourself when it's green" about merges. The local GitHub
 * stand-in (`./githubStub.ts`) records every merge the app asks for through
 * its own sign-in, so "nothing merged" is read off the forge, not off prose.
 * Each test starts from its own fresh app, repository and stand-in.
 */

const REPO_NAME = "meterlab";
const HELD_TITLE = `${REPO_NAME} ${AUTONOMY_PROMPT_MARKER}`;
const ASKED_TITLE = `${REPO_NAME} ${AUTONOMY_PROMPT_MARKER}, ${AUTONOMY_ASK_MARKER}`;

/** The change GitHub holds for the task's branch, as its crewmate opened it. */
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
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'quick')",
  ).run("repo-meterlab", repoDir, REPO_NAME, Date.now(), "https://github.com/o/meterlab.git");
  seedHostedOrigins(db, userDataDir);
  db.close();
  launched = await launchApp({
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

/** GitHub's squash of the task's change at exactly that head, with its own title. */
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
  await expect(factsStrip(frame).care).toHaveText(CARE_WORDS.quick);
  await expect(page.getByRole("button", { name: MERGE_WORDS["merge-pr"] })).toBeVisible();

  // The Firstmate reaches for the merge, and the host refuses. The refusal
  // is a tool result, not a feed line - there is nothing to announce, since
  // the decision it hands back is the button already on screen.
  await send(`${MERGE_PROMPT_MARKER}${HELD_TITLE}`);
  await expect(feedLine(page, new RegExp(MERGE_PROMPT_MARKER))).toBeVisible({ timeout: 30_000 });

  // Nothing merged - read off the forge, not off prose - and the decision
  // is still in front of the captain, on the card, with its own button.
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

  // And the captain's own click on that button is the way out the refusal
  // named: the same task, the same merge, never held - at the checked head.
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

test("a task the captain said to merge on green merges itself, on the same ask-first repository", async () => {
  const { page } = launched;
  await send(`${SPAWN_PROMPT_MARKER} ${ASKED_TITLE}`);
  const cardTitle = MOCK_AUTONOMY_CARD_TITLE(ASKED_TITLE);
  await expect(shownCard(page, cardTitle)).toBeVisible({ timeout: 30_000 });
  // The per-task autonomy ask on an ask-first project changes the hold,
  // not the task's care.
  const frame = cardBody(page, cardTitle);
  await expect(factsStrip(frame).care).toHaveText(CARE_WORDS.quick);

  await page.screenshot({ path: test.info().outputPath("autonomy-on-card.png") });

  // The SAME Firstmate move the first test was refused for, on a
  // repository set up the same way: the per-task ask is the whole difference.
  expect(github.merges()).toEqual([]);
  const head = await checkedHead(ASKED_TITLE);
  await send(`${MERGE_PROMPT_MARKER}${ASKED_TITLE}`);
  // This task's own merge line: the captain's-click receipt is not this
  // path's, and a feed shared with another test would show that one's.
  await expect(putInLine(page, await taskKey(page, ASKED_TITLE))).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => github.merges(), { timeout: 15_000 }).toEqual(squashAt(head));
  await expect
    .poll(
      async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        const task = board.tasks.find((row) => row.title === ASKED_TITLE);
        return task ? page.evaluate((id) => window.infinitary.tasks.detail(id), task.id) : null;
      },
      { timeout: 15_000 },
    )
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
  // Read off the forge: the app sent no merge of its own.
  expect(github.merges()).toEqual([]);
  expect(github.requests().filter((request) => request.endsWith("/merge"))).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("merged-by-hand-closed.png") });
});
