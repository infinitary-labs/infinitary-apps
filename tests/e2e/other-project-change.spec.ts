import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ChangeStore } from "../../src/core/storage/changeStore";
import { openDatabase } from "../../src/core/storage/db";
import { MERGE_CLOSES_WORDS } from "../../src/shared/cards";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  OTHER_BRANCH,
  OTHER_CARD_TITLE,
  OTHER_PROJECT,
  OTHER_PROJECT_MARKER,
  OTHER_TITLE,
  otherProjectChange,
} from "./scenarios/otherProjectChange";
import { factsStrip, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * INF-2510, the captain's INF-1868 answer 2: "Only repositories the app
 * manages as projects, for example dotfiles-private while working on INF".
 *
 * - Promised result: a crewmate working in one project opens its change in
 *   another project the app manages, from the branch it pushed there; the
 *   change is read, offered and merged in that project, never in the task's
 *   own, and the record keeps it under that project.
 * - Data: two real git projects in the scratch data, `shipyard` (the task's
 *   own) and `dotfiles-private`, whose pushed branch carries a conventional
 *   commit; the scripted `otherProjectChange` crewmate.
 * - Completion signal: GitHub's merge of that project's pull request, and
 *   the task closed as merged.
 * - Platform prerequisites: desktop Electron and local git.
 * - Shared resources: none; GitHub is the local stand-in (`./githubStub.ts`)
 *   and no real sign-in or pull request is reached.
 */

const MERGE = MERGE_WORDS["merge-pr"];
const OWN_PROJECT = "shipyard";
const OWN_ID = "repo-shipyard";
const OTHER_ID = "repo-dotfiles";
/** The spawn binds the project its title names: the task's own, shipyard. */
const TASK_TITLE = `${OWN_PROJECT} ${OTHER_PROJECT_MARKER}`;

function gitProject(userDataDir: string, folder: string) {
  const dir = join(userDataDir, folder);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir], { stdio: "pipe" });
  git("config", "user.name", "Test");
  git("config", "user.email", "test@localhost");
  git("commit", "--quiet", "--allow-empty", "-m", "init");
  return { dir, git, head: (ref: string) => git("rev-parse", ref) };
}

async function send(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function cardTask(page: Page, title: string): Promise<string> {
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  const taskId = cards.find((card) => card.title === title)?.taskId;
  if (!taskId) throw new Error(`No task card titled "${title}"`);
  return taskId;
}

test("a crewmate opens its change in another project the app manages, and the completion card merges it there", async () => {
  const userDataDir = scratchDir("infinitary-other-project-");
  const own = gitProject(userDataDir, OWN_PROJECT);
  const other = gitProject(userDataDir, OTHER_PROJECT);
  // The crewmate pushed its work to the other project under a branch of its own.
  other.git("checkout", "--quiet", "-b", OTHER_BRANCH);
  other.git("commit", "--quiet", "--allow-empty", "-m", OTHER_TITLE);
  other.git("checkout", "--quiet", "main");
  const otherHead = other.head(`refs/heads/${OTHER_BRANCH}`);

  const github = await startGitHubStub();
  github.headOf((branch) =>
    branch === OTHER_BRANCH ? otherHead : own.head(`refs/heads/${branch}`),
  );
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: OWN_ID,
    path: own.dir,
    name: OWN_PROJECT,
    setupKind: "clone",
    origin: `https://github.com/octo/${OWN_PROJECT}.git`,
    runsOn: null,
    delivery: "direct-pr",
  });
  seedProject(db, {
    id: OTHER_ID,
    path: other.dir,
    name: OTHER_PROJECT,
    setupKind: "clone",
    origin: "https://github.com/octo/dotfiles.git",
    runsOn: null,
    delivery: "direct-pr",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [otherProjectChange],
    userDataDir,
    env: github.env,
  });
  const page = launched.page;
  try {
    await send(page, `${SPAWN_PROMPT_MARKER} ${TASK_TITLE}`);
    const finish = shownCard(page, OTHER_CARD_TITLE);
    await expect(finish).toBeVisible({ timeout: 30_000 });
    const taskId = await cardTask(page, OTHER_CARD_TITLE);

    // The change opened in the other project, from the branch pushed there.
    expect(github.requests()).toContain("POST /repos/octo/dotfiles/pulls");
    expect(github.requests()).not.toContain(`POST /repos/octo/${OWN_PROJECT}/pulls`);
    expect(other.head(`refs/infinitary/opened/${taskId}`)).toBe(otherHead);
    // Its checks were read there.
    expect(github.requests().some((line) => line.startsWith("GET /repos/octo/dotfiles/"))).toBe(
      true,
    );

    const facts = factsStrip(cardBody(page, OTHER_CARD_TITLE));
    await expect(facts.mergeLine).toHaveText(MERGE_CLOSES_WORDS.closes);
    await expect(facts.change).toHaveText(`${OTHER_PROJECT} #100`);
    await expect(facts.change.locator("a")).toHaveAttribute(
      "href",
      "https://github.com/octo/dotfiles/pull/100",
    );
    await regionShot(finish, test.info().outputPath("other-project-card.png"));

    await pressKey(finish.getByRole("button", { name: MERGE, exact: true }), "Enter");
    await expect
      .poll(() => github.merges().map((merge) => ({ number: merge.number, sha: merge.sha })), {
        timeout: 20_000,
      })
      .toEqual([{ number: 100, sha: otherHead }]);
    expect(github.mergeRequests()).toEqual(["PUT /repos/octo/dotfiles/pulls/100/merge-async"]);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId), {
        timeout: 20_000,
      })
      .toMatchObject({ status: "done", closedReason: "merged" });

    const changes = readSavedData(userDataDir, (saved) =>
      new ChangeStore(saved).allForTask(taskId).map((change) => ({
        repoId: change.repoId,
        number: change.handle?.number,
      })),
    );
    expect(changes).toContainEqual({ repoId: OTHER_ID, number: 100 });
  } finally {
    await launched.close();
    await github.close();
  }
});
