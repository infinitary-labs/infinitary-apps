import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  MERGE_LINE_MARK,
  MERGE_SETTING_WORDS,
  mergedWords,
} from "../../src/core/orchestrator/settleWords";
import { openDatabase } from "../../src/core/storage/db";
import type { RiskDimension } from "../../src/shared/cards";
import { CARE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { MOCK_CLOSING_SENTENCES, MOCK_RISK, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import {
  MOCK_SELF_MERGE_CHANGE_TITLE,
  SELF_MERGE_NOTE_PROMPT_MARKER,
  selfMergeNote,
} from "./scenarios/selfMergeNote";
import { factsStrip, riskChart, shownCard } from "./stack";

/**
 * INF-1219, the captain's words: "this card UI in infinitary needs an UX
 * improvement - it misses the radar chart, and also it's not clear that this
 * was a change merged by itself". INF-2533 moved when the note shows: a
 * task that merges on its own keeps its story note off the stack until the
 * merge has a result, then shows it once. INF-2744 made that note the
 * task's merge card: the crewmate puts it up like any other, and the app
 * merges from it itself, with no first mate turn. The promised result: the
 * app merges with no message to the first mate, and one note then draws its
 * crewmate's risk radar and the merge card's fact strip, holds no button,
 * and says it merged on its own. The data is a project on a local GitHub
 * stand-in set to merge on its own, with one commissioned task that
 * publishes a saved story; the completion signals are the risk the task's
 * record keeps from the card, the stand-in's recorded merge and the task's
 * merged record. It needs the hermetic launcher and its own stand-in, and
 * shares nothing with another test.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

let launched: LaunchedApp;
let github: GitHubStub;

test.afterEach(async () => {
  await launched?.close();
  await github?.close();
});

/** A project whose origin is on GitHub while every push lands on a bare repository here. */
function seedMeterlab(userDataDir: string): string {
  const bare = join(userDataDir, "github-meterlab.git");
  git("init", "--bare", "--initial-branch=main", bare);
  const dir = join(userDataDir, "meterlab");
  const origin = "https://github.com/octo/meterlab.git";
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(
    join(dir, ".github/workflows/verify.yml"),
    "name: verify\non:\n  workflow_dispatch:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo verified\n",
  );
  git("-C", dir, "add", ".github/workflows/verify.yml");
  git("-C", dir, "commit", "-m", "chore: seed verification");
  git("-C", dir, "remote", "add", "origin", origin);
  git("-C", dir, "config", `url.${bare}.insteadOf`, origin);
  git("-C", dir, "push", "origin", "HEAD:refs/heads/main");
  // Direct-pr, autonomy ON (1): the project's own setting merges on its own.
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: dir,
    name: "meterlab",
    setupKind: "clone",
    origin: origin,
    runsOn: null,
    delivery: "direct-pr",
    autonomy: true,
    rigor: "quick",
    addedAt: 1,
  });
  db.close();
  return bare;
}

async function send(text: string): Promise<void> {
  const input = promptInput(launched.page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

test("a merge card the app merges on its own shows once, after the merge, with its radar, facts and merged line (INF-2744)", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = scratchDir("infinitary-self-merge-note-");
  const bare = seedMeterlab(userDataDir);
  seedGitHubSignIn(userDataDir);
  github = await startGitHubStub();
  github.headOf((branch) => git("-C", bare, "rev-parse", `refs/heads/${branch}`));
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [selfMergeNote],
    userDataDir,
    env: github.env,
  });
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 1280, height: 1000 });
  const pictures = process.env.INFINITARY_SELF_MERGE_PICTURES;
  const title = `meterlab ${SELF_MERGE_NOTE_PROMPT_MARKER}`;
  const note = shownCard(page, MOCK_SELF_MERGE_CHANGE_TITLE);
  const frame = cardBody(page, MOCK_SELF_MERGE_CHANGE_TITLE);
  let taskId = "";

  await test.step("the app merges from the merge card, with no word to the first mate (INF-2744)", async () => {
    await send(`${SPAWN_PROMPT_MARKER} ${title}`);
    await expect
      .poll(
        async () => {
          const board = await page.evaluate(() => window.infinitary.tasks.board());
          taskId = board.tasks.find((entry) => entry.title === title)?.id ?? "";
          return github.merges().length;
        },
        { timeout: 60_000 },
      )
      .toBe(1);
    // The task's record keeps the card's ratings, as it keeps any merge card's.
    const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
    expect(detail?.delivery?.risk?.declared).toEqual(MOCK_RISK);
  });

  await test.step("the note shows once, saying it merged on its own", async () => {
    await expect(note).toBeVisible({ timeout: 30_000 });
    const line = frame.locator(`[${MERGE_LINE_MARK}]`);
    // No first mate turn merged it, so the line carries no closing sentence.
    await expect(line).not.toContainText(MOCK_CLOSING_SENTENCES["merge-pr"]);
    // The card the app merged from holds no button.
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.title === MOCK_SELF_MERGE_CHANGE_TITLE,
      )?.actions,
    ).toEqual([]);
    // The lead before its time, from the words' owner.
    await expect(line).toContainText(mergedWords("", true).trim());
    const number = github.merges()[0]?.number;
    await expect(line.locator("a")).toHaveText(`PR #${number}`);
    await expect(line).not.toContainText(MERGE_SETTING_WORDS.project);
    // The crewmate's own seven ratings from its saved story, as a merge card draws them.
    const risk = riskChart(page);
    await expect(risk.chart).toBeVisible();
    for (const [dimension, rating] of Object.entries(MOCK_RISK))
      await expect(risk.dot(dimension as RiskDimension)).toHaveAttribute(
        "data-risk-level",
        rating.level,
      );
    // The merge card's fact strip beside Chat, the pull request linked.
    const facts = factsStrip(frame);
    await expect(facts.project).toHaveText("meterlab");
    await expect(facts.care).toHaveText(CARE_WORDS.quick);
    await expect(facts.change.locator("a")).toHaveAttribute("href", /\/pull\/\d+$/);
    // One note: no closing note of the first mate's beside it.
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title),
    ).toEqual([MOCK_SELF_MERGE_CHANGE_TITLE]);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "done", closedReason: "merged" });
    if (pictures) await regionShot(note, join(pictures, "self-merge-note-merged.png"));
    // The release note's picture: the merged note with its radar and facts.
    await heroShot(launched.app, page, {
      region: note,
      name: "self-merge-note-once",
      dir: test.info().outputPath("hero"),
    });
  });
});
