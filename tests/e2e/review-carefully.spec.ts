import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { POLICY_GUIDANCE_HEADING } from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { reportSummary } from "../../src/shared/feed";
import type { TaskView } from "../../src/shared/tasks";
import {
  CARE_WORDS,
  CHECK_WORDS,
  MERGE_WORDS,
  REVIEW_CAREFULLY_WORDS,
} from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { REVIEW_CAREFULLY_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { reportLine, startedLine } from "./rails";
import {
  MOCK_CAREFUL_BUILDER_REPORT,
  MOCK_CAREFUL_CARD_TITLE,
  MOCK_CAREFUL_REVIEWED_CARD_TITLE,
  reviewCarefully,
} from "./scenarios/reviewCarefully";
import { MOCK_REVIEWED_CHANGE, REVIEW_BRIEF_MARKER, reviewedTier } from "./scenarios/reviewedTier";
import { expectNoCard, factsStrip, shownCard } from "./stack";
import { setThemeViaSettings } from "./theme";
import { pressWindowKey, untilWindowCommands } from "./windowKeys";

/**
 * Review carefully (INF-562, the captain's plan: "the most natural place to
 * make use of the careful care level is when a merge completion card is
 * raised, and they looked at the card and felt it's risky"), end to end by
 * keys: a Default pull request's merge card offers Review carefully at ⌘2;
 * the key closes the card, makes the task Careful and starts its crewmate,
 * which reports without pushing; the app starts the review of the version
 * the card offered (INF-1875), whose brief names the card the captain read;
 * the pass brings a new merge card,
 * Careful with the review's verdict and no Review carefully, while the pull
 * request was never touched.
 *
 * Real: the repository, the working copies, the care edit, the card path,
 * the review brief, the verdict. Stand-ins: the models (the mock
 * provider) and GitHub (`./githubStub.ts`).
 */

const REPO_NAME = "meterlab";
const TITLE = `${REPO_NAME} ${REVIEW_CAREFULLY_MARKER}`;

let launched: LaunchedApp;
let github: GitHubStub;
let repoDir: string;

test.beforeEach(async () => {
  const userDataDir = scratchDir("infinitary-review-carefully-");
  const repo = seedRepo(userDataDir);
  repoDir = repo.repoDir;
  github = await startGitHubStub();
  github.servePull({ number: 57, ...MOCK_REVIEWED_CHANGE });
  github.headOf((branch) =>
    execFileSync("git", ["-C", repoDir, "rev-parse", `refs/heads/${branch}`], {
      encoding: "utf8",
    }).trim(),
  );
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'standard')",
  ).run("repo-meterlab", repo.repoDir, REPO_NAME, Date.now(), "https://github.com/o/meterlab.git");
  seedHostedOrigins(db, userDataDir);
  db.close();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [reviewCarefully, reviewedTier],
    userDataDir,
    env: github.env,
  });
});

test.afterEach(async () => {
  await launched.close();
  await github.close();
});

async function taskRow(match: (task: TaskView) => boolean): Promise<TaskView> {
  const find = async () =>
    (await launched.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(match) ?? null;
  await expect.poll(find, { timeout: 30_000 }).not.toBeNull();
  return (await find()) as TaskView;
}

test("a Default pull request's merge card is made Careful by ⌘2, reviewed, and comes back to merge", async () => {
  const { page, app, mockProvider } = launched;
  await resizeWindow(app, page, { width: 1200, height: 800 });
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
  await input.press("Enter");
  const builder = await taskRow((task) => task.title === TITLE);
  await expect(startedLine(page, builder.key)).toBeVisible({ timeout: 30_000 });

  // 1. The merge card at Default care: Discard, Review carefully and Merge,
  //    in that order, so Merge keeps ⌘1 and Review carefully takes ⌘2.
  const card = shownCard(page, MOCK_CAREFUL_CARD_TITLE);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const frame = cardBody(page, MOCK_CAREFUL_CARD_TITLE);
  await expect(factsStrip(frame).care).toHaveText(CARE_WORDS.standard);
  await expect(factsStrip(frame).checks).toHaveText(CHECK_WORDS.green);
  const footer = card.getByRole("button", {
    name: new RegExp(`^(Discard|${REVIEW_CAREFULLY_WORDS}|${MERGE_WORDS["merge-pr"]})`),
  });
  await expect(footer).toHaveText([
    /^Discard/,
    new RegExp(`^${REVIEW_CAREFULLY_WORDS}`),
    new RegExp(`^${MERGE_WORDS["merge-pr"]}`),
  ]);
  // The choice by its whole name: the captain's question above it quotes
  // "review carefully", and a short question's bubble is a button too.
  const reviewChoice = { name: REVIEW_CAREFULLY_WORDS, exact: true };
  await expect(card.getByRole("button", reviewChoice)).toContainText("2");
  const builderHead = execFileSync(
    "git",
    ["-C", repoDir, "rev-parse", `refs/heads/fm/task-${builder.id}`],
    { encoding: "utf8" },
  ).trim();
  await card.screenshot({ path: test.info().outputPath("merge-card-review-carefully.png") });
  for (const theme of ["dark", "light"] as const) {
    await setThemeViaSettings(page, theme);
    await regionShot(card, test.info().outputPath(`merge-card-${theme}.png`));
  }
  await setThemeViaSettings(page, "dark");
  await heroShot(app, page, {
    region: card,
    name: "review-carefully",
    dir: test.info().outputPath("hero"),
  });

  // 2. ⌘2 closes the card, grants no merge and makes this task Careful,
  //    from the captain and the merge card.
  await untilWindowCommands(page);
  await pressWindowKey(app, "2", ["meta"]);
  await expectNoCard(page, MOCK_CAREFUL_CARD_TITLE);
  const detail = () => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id);
  await expect
    .poll(detail, { timeout: 30_000 })
    .toMatchObject({ policies: { rigor: { value: "reviewed", source: "task" } } });
  const edit = (await detail()).events.find(
    (event) => event.kind === "note" && event.text.includes(CARE_WORDS.reviewed),
  );
  expect(edit).toMatchObject({ actor: "captain" });
  expect(edit?.text).toContain("from the merge card");

  // 3. The crewmate started with the care notice, carrying the Careful
  //    guidance the raise selects, ahead of the choice, and reported
  //    without pushing.
  await expect(
    reportLine(page, builder.key).filter({ hasText: reportSummary(MOCK_CAREFUL_BUILDER_REPORT) }),
  ).toBeVisible({ timeout: 30_000 });
  // The notice and the choice reached the crewmate on the same turn, the
  // notice first.
  const started = (mockProvider?.requestBodies() ?? []).find((body) =>
    body.includes(POLICY_GUIDANCE_HEADING),
  );
  expect(started).toBeDefined();
  expect(started?.indexOf(POLICY_GUIDANCE_HEADING)).toBeLessThan(
    started?.lastIndexOf(REVIEW_CAREFULLY_WORDS) ?? -1,
  );

  // 4. The app started the review of the version the card offered; its
  //    brief names the open pull request and the card the captain read,
  //    saved whole as a file. The reviewer sends its brief only after its
  //    row exists (INF-632).
  const review = await taskRow((task) => task.reviewOf === builder.id);
  const briefed = () =>
    (mockProvider?.requestBodies() ?? []).find(
      (body) => body.includes(REVIEW_BRIEF_MARKER) && body.includes(MOCK_CAREFUL_CARD_TITLE),
    );
  await expect.poll(() => briefed() ?? null, { timeout: 30_000 }).not.toBeNull();
  const brief = briefed();
  expect(brief).toContain("pull/57");
  const saved = brief?.match(/(\/[^\s"\\]*merge-card-[^\s"\\]+\.html)/)?.[1];
  expect(saved).toBeDefined();
  expect(readFileSync(saved as string, "utf8")).toContain("Ten consecutive runs passed");

  // 5. The pass on the version already pushed brings a new merge card:
  //    Careful, the review beside the checks, and no Review carefully.
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), review.id), {
      timeout: 30_000,
    })
    .toMatchObject({ status: "done" });
  const again = shownCard(page, MOCK_CAREFUL_REVIEWED_CARD_TITLE);
  await expect(again).toBeVisible({ timeout: 30_000 });
  const againFacts = factsStrip(cardBody(page, MOCK_CAREFUL_REVIEWED_CARD_TITLE));
  await expect(againFacts.care).toHaveText(CARE_WORDS.reviewed);
  await expect(againFacts.review).toContainText("risk low");
  await expect(again.getByRole("button", reviewChoice)).toHaveCount(0);
  await expect(again.getByRole("button", { name: MERGE_WORDS["merge-pr"] })).toBeVisible();
  await again.screenshot({ path: test.info().outputPath("merge-card-after-review.png") });

  // The pull request was never touched: the same version, nothing merged.
  expect(
    execFileSync("git", ["-C", repoDir, "rev-parse", `refs/heads/fm/task-${builder.id}`], {
      encoding: "utf8",
    }).trim(),
  ).toBe(builderHead);
  expect(github.merges()).toEqual([]);
});
