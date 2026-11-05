import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { renderRigorSection } from "../../src/core/orchestrator/intentBrief";
import {
  openReviewText,
  REVIEW_PASSED_NEXT,
  reviewFindingsNext,
} from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import { COMPLETION_CARD_HEADINGS } from "../../src/shared/cardHeadings";
import { MERGE_CLOSES_WORDS, REVIEW_FINDING_LABEL } from "../../src/shared/cards";
import { reportSummary } from "../../src/shared/feed";
import { validationStateRevision } from "../../src/shared/liveValidation";
import type { TaskView } from "../../src/shared/tasks";
import { CARE_WORDS, CHECK_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { FM_SYSTEM_MARKER, REVIEWED_TIER_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { captainCardChoice, latestServedTurn, providerMessages } from "./providerRequest";
import { putInLine, reportLine, startedLine, statusLine, taskLine } from "./rails";
import { readSavedData } from "./savedData";
import { captainWords } from "./scenarios/agentsReach";
import {
  MOCK_CAP_RETRY_STEER,
  MOCK_REVIEW_ASK_CARD_TITLE,
  MOCK_REVIEW_AUTOFIX_FINDING,
  MOCK_REVIEW_CAP_CARD_TITLE,
  MOCK_REVIEW_CAP_RETRY_LABEL,
  MOCK_REVIEW_KEEP_LABEL,
  MOCK_REVIEW_KEEP_STEER,
  MOCK_REVIEW_REFIX_STEER,
  MOCK_REVIEWED_BUILDER_REPORT,
  MOCK_REVIEWED_CARD_TITLE,
  MOCK_REVIEWED_CHANGE,
  MOCK_REVIEWED_FIX_REPORT,
  MOCK_REVIEWED_KEEP_REPORT,
  MOCK_REVIEWED_READ_STEER,
  MOCK_REVIEWED_READ_WORDS,
  MOCK_REVIEWED_REFIX_REPORT,
  MOCK_REVIEWED_RETRY_REPORT,
  REREVIEW_PROMPT_MARKER,
  REVIEW_BRIEF_MARKER,
  reviewedTier,
} from "./scenarios/reviewedTier";
import { expectNoCard, factsStrip, pager, showCard, shownCard } from "./stack";
import { setThemeViaSettings } from "./theme";

/**
 * Delivery rigor, phase 2 (`docs/delivery-rigor.md`, the reviewed tier),
 * end to end through the real app on real Pi sessions: a direct-pr task
 * the captain asked to ship reviewed (`rigor_ask` - since the 2026-09-19
 * ruling nothing else derives reviewed) is briefed with the reviewed rigor
 * line and reports its green PR with NO completion card (this spec rides
 * the path where a pull request is already on record: the review still
 * reads the builder's committed branch head, which this journey keeps
 * equal to the recorded pull request head - `crewSupervisor.test.ts` covers
 * a recorded head that has fallen behind); the Firstmate checks CI and spawns the reviewer
 * with `review_of`; the host briefs the reviewer read-only and holds
 * nothing on the builder for it (INF-1876); the reviewer's findings reach
 * the Firstmate directly (never supervision) and become one steer and one
 * decision card; repeated re-reviews return findings without a host round
 * allowance; a later re-review passes, which closes the review task and is
 * one feed line; the completion card shows the review, says its merge leaves
 * the task open while the ask-user card stands (INF-2525), and once the
 * captain answers that card it merges and closes the task.
 *
 * Real: the repository, task working copies, care derivation, review brief,
 * the typed verdict, card path and settle. Stand-ins: models (the mock
 * provider IS the scripted shape of each session) and GitHub, a local
 * stand-in the app reads through its own sign-in, which answers the change,
 * its checks and the merge the way GitHub's API would (`./githubStub.ts`).
 */

const REPO_NAME = "meterlab";
const BUILDER_TITLE = `${REPO_NAME} ${REVIEWED_TIER_PROMPT_MARKER}`;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

let repoDir: string;
let userDataDir: string;

/** A task branch's commit now: the head of its change on GitHub. */
const branchHead = (branch: string) => git(repoDir, "rev-parse", `refs/heads/${branch}`);

/**
 * The builder sends up its fix: one more save point on its own branch, the
 * change's new head (a round is one per head, 2026-09-19). Its working copy
 * keeps the same files, so it stays clean.
 */
function pushFix(branch: string, subject: string): string {
  const tip = branchHead(branch);
  const next = git(repoDir, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", subject);
  git(repoDir, "update-ref", `refs/heads/${branch}`, next, tip);
  return next;
}

/** The builder's readings so far (`builderReads`). */
let readings = 0;

/**
 * The builder's own check_change after it pushes, through the app: the
 * captain asks, the first mate relays it, and the scripted builder reads the
 * head and its green checks and revalidates it (`reviewedTier`), which is
 * what the Firstmate and the review round read. The app is the one writer
 * while it runs (INF-1153): a write from here could collide with its own
 * and fail with "database is locked", as agents-reach's did (INF-1148).
 */
async function builderReads(taskId: string, head: string): Promise<void> {
  // Each reading is its own captain turn, told apart by its count.
  readings += 1;
  const words = `${MOCK_REVIEWED_READ_WORDS} (reading ${readings})`;
  const read = launched.mockProvider?.scriptFirstmateTurn(captainWords(words), [
    { name: "steer_crewmate", args: { task_id: taskId, message: MOCK_REVIEWED_READ_STEER } },
  ]);
  if (!read) throw new Error("this journey runs on the mock provider");
  const input = promptInput(launched.page);
  await input.click();
  await input.fill(words);
  await input.press("Enter");
  await expect
    .poll(read.outcome, { timeout: 30_000 })
    .toEqual(expect.objectContaining({ state: "closed" }));
  const stored = () =>
    readSavedData(userDataDir, (db) => new TaskStore(db).get(taskId)?.delivery ?? null);
  await expect
    .poll(stored, { timeout: 30_000 })
    .toMatchObject({ ci: "green", headSha: head, validationHead: head });
  await expect
    .poll(() => stored()?.liveValidation?.runs.some((run) => run.head === head), {
      timeout: 30_000,
    })
    .toBe(true);
}

/** The first board row that matches, once the board holds one. */
async function boardRow(
  launched: LaunchedApp,
  match: (task: TaskView) => boolean,
): Promise<TaskView> {
  const find = async () =>
    (await launched.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(match) ?? null;
  await expect.poll(find, { timeout: 30_000 }).not.toBeNull();
  return (await find()) as TaskView;
}

/**
 * Every wake the Firstmate was served across the run, as the host framed
 * it: each request's newest input, segment by segment.
 */
function servedToFirstmate(): string[] {
  return (launched.mockProvider?.requestBodies() ?? [])
    .filter((body) => body.includes(FM_SYSTEM_MARKER))
    .flatMap((body) => latestServedTurn(body)?.segments ?? [])
    .map((segment) => segment.body);
}

/** How many steers a task's record holds. */
async function steersOn(taskId: string): Promise<number> {
  const detail = await launched.page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
  return detail.events.filter((event) => event.kind === "steered").length;
}

let launched: LaunchedApp;
let github: GitHubStub;

test.beforeAll(async () => {
  userDataDir = scratchDir("infinitary-rigor-reviewed-");
  const repo = seedRepo(userDataDir);
  repoDir = repo.repoDir;
  github = await startGitHubStub();
  // The builder's change: its head is always the commit on its own branch,
  // which settlement checks save point by save point before the squash.
  github.servePull({ number: 55, ...MOCK_REVIEWED_CHANGE });
  github.headOf(branchHead);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repo.repoDir,
    name: REPO_NAME,
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [reviewedTier],
    userDataDir,
    env: github.env,
  });
});

test.afterAll(async () => {
  await launched.close();
  await github.close();
});

test("a reviewed task's review passes before its completion card, which merges with the review on it", async () => {
  const { page, mockProvider } = launched;
  const input = promptInput(page);
  await resizeWindow(launched.app, page, { width: 1280, height: 900 });

  // 1. The builder: a direct-pr task the captain asked to ship reviewed
  //    (the mock Firstmate passes rigor_ask, the captain's words on care).
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${BUILDER_TITLE}`);
  await input.press("Enter");
  const builder = await boardRow(launched, (task) => task.title === BUILDER_TITLE);
  await expect(startedLine(page, builder.key)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id))
    .toMatchObject({ rigor: "reviewed" });

  // 2. Its green report is one feed line and NO card: the reviewed brief
  //    withholds the completion card until the Firstmate says so.
  //    The builder reports again later (its fixes), so this is its first.
  const greenReport = reportLine(page, builder.key).first();
  await expect(greenReport).toBeVisible({ timeout: 30_000 });
  await expect(greenReport).toContainText(reportSummary(MOCK_REVIEWED_BUILDER_REPORT));
  // The builder saved its work before reporting: its branch's commit is the head.
  const builderBranch = `fm/task-${builder.id}`;
  const HEAD_SHA = branchHead(builderBranch);
  const initialProofRevision = (
    await page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id)
  ).liveValidation?.revision;
  expect(initialProofRevision).toBeDefined();
  expect(git(repoDir, "log", "-1", "--format=%s", HEAD_SHA)).toBe(MOCK_REVIEWED_CHANGE.title);
  await page.screenshot({ path: test.info().outputPath("rigor-reviewed-activity.png") });
  await expectNoCard(page, MOCK_REVIEWED_CARD_TITLE);

  // 3. The Firstmate checked CI and spawned the reviewer with review_of:
  //    a fresh crewmate on the same repository, titled by the host.
  const review = await boardRow(launched, (task) => task.reviewOf === builder.id);
  await expect(startedLine(page, review.key)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id))
    .toMatchObject({
      status: "active",
      blockedBy: [],
      delivery: expect.objectContaining({
        prUrl: "https://github.com/o/meterlab/pull/55",
        headSha: HEAD_SHA,
        ci: "green",
      }),
    });
  // The review is the builder's child: the parent edge is the one join.
  expect(await page.evaluate((id) => window.infinitary.tasks.detail(id), review.id)).toMatchObject({
    parentId: builder.id,
    basis: { ref: builder.id, verified: true },
  });

  // 4. The reviewer's findings: the auto-fix reached the builder as a steer
  //    (it reports the fix), the ask-user finding is one decision card on
  //    the builder's task from the Firstmate.
  await expect(reportLine(page, review.key).first()).toBeVisible({ timeout: 30_000 });
  await expect(shownCard(page, MOCK_REVIEW_ASK_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  const findingCard = shownCard(page, MOCK_REVIEW_ASK_CARD_TITLE);
  await expect(findingCard.getByText(REVIEW_FINDING_LABEL, { exact: true })).toBeVisible();
  await expect(findingCard.locator("[data-card-meta]")).toHaveText(builder.title);
  const findingFacts = factsStrip(cardBody(page, MOCK_REVIEW_ASK_CARD_TITLE));
  await expect(findingFacts.project).toContainText(REPO_NAME);
  await expect(findingFacts.review).toContainText(HEAD_SHA.slice(0, 7));
  await expect(findingFacts.review).toContainText("risk medium");
  await expect(page.getByRole("button", { name: MOCK_REVIEW_KEEP_LABEL })).toBeVisible();
  await expect(
    reportLine(page, builder.key).filter({ hasText: reportSummary(MOCK_REVIEWED_FIX_REPORT) }),
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id))
    .toMatchObject({
      delivery: expect.objectContaining({ reviewVerdict: "findings", reviewRisk: "medium" }),
    });

  for (const theme of ["dark", "light"] as const) {
    await setThemeViaSettings(page, theme);
    await regionShot(
      shownCard(page, MOCK_REVIEW_ASK_CARD_TITLE),
      test.info().outputPath(`review-finding-${theme}.png`),
    );
  }
  await setThemeViaSettings(page, "dark");

  // INF-203 F2: the wake now carries validation state as well as code and evidence.
  // Read those facts from their owner and derive the complete wording, rather than pinning a fragment.
  const firstReviewState = readSavedData(userDataDir, (db) => {
    const stored = new TaskStore(db);
    return {
      assignment: stored.get(review.id)?.delivery?.validationAssignment,
      current: validationStateRevision(stored.get(builder.id)?.delivery?.liveValidation),
    };
  });
  expect(firstReviewState.assignment).toBeDefined();

  // 5. No hold: the review holds nothing on the builder (INF-1876), so the
  //    task waits on nothing while the review is open, and nothing was
  //    merged - the merge is the captain's click on the completion card.
  expect(github.merges()).toEqual([]);
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id))
    .toMatchObject({ status: "active", closedReason: null, blockedBy: [] });

  // Accepted INF-1177: repeated review facts never create a host round allowance.
  const detail = () => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id);
  for (const [index, subject] of [
    "fix: await the meter snapshot",
    "fix: keep the meter steady",
  ].entries()) {
    if (index)
      await expect(
        reportLine(page, builder.key).filter({
          hasText: reportSummary(MOCK_REVIEWED_REFIX_REPORT),
        }),
      ).toBeVisible({ timeout: 30000 });
    const head = pushFix(builderBranch, subject);
    await builderReads(builder.id, head);
    await input.fill(REREVIEW_PROMPT_MARKER);
    await input.press("Enter");
    await expect.poll(detail, { timeout: 30000 }).toMatchObject({
      delivery: expect.objectContaining({ reviewSha: head, reviewVerdict: "findings" }),
    });
    expect((await detail()).delivery?.reviewCapAt).toBeUndefined();
    expect((await detail()).delivery?.reviewRounds).toBeUndefined();
  }
  // 8. The captain's re-review at yet another head: the pass closes the
  //    review task, records the verdict and risk on the builder, releases
  //    the hold, and is one feed line - the builder's own.
  const FINAL_SHA = pushFix(builderBranch, "fix: finish the meter review");
  await builderReads(builder.id, FINAL_SHA);
  await input.click();
  await input.fill(REREVIEW_PROMPT_MARKER);
  await input.press("Enter");
  // The pass is the builder's review line carrying the risk it recorded;
  // the findings rounds' lines carry none.
  await expect(taskLine(page, builder.key, "review").filter({ hasText: "low" })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), review.id))
    .toMatchObject({ status: "done", closedReason: "finished", rigor: null });
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id))
    .toMatchObject({
      status: "active",
      blockedBy: [],
      delivery: expect.objectContaining({
        reviewVerdict: "pass",
        reviewSha: FINAL_SHA,
        reviewRisk: "low",
        reviewRiskNote: "one test file changed.",
      }),
    });
  // The review task's own close is silent: no status line for it.
  await expect(statusLine(page, review.key)).toHaveCount(0);

  // 9. Told the review passed, the builder emits its completion card, which
  //    renders the five headings and the host's facts strip with the review
  //    beside CI. The ask-user card is the Firstmate's and still stands, so
  //    the stack holds two and the new one waits unread until paged to
  //    (WI-18: a new card never steals the shown one).
  await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
  await showCard(page, MOCK_REVIEWED_CARD_TITLE);
  const frame = cardBody(page, MOCK_REVIEWED_CARD_TITLE);
  await expect(frame.locator("h3")).toHaveText([...COMPLETION_CARD_HEADINGS]);
  const facts = factsStrip(frame);
  await expect(facts.project).toHaveText(REPO_NAME);
  await expect(facts.care).toHaveText(CARE_WORDS.reviewed);
  await expect(facts.change.locator('a[href="https://github.com/o/meterlab/pull/55"]')).toHaveText(
    "#55",
  );
  await expect(facts.checks).toHaveText(CHECK_WORDS.green);
  // The review cell names the head it read and the risk; the risk note
  // rides the cell's title, never a line of its own.
  await expect(facts.review).toContainText(FINAL_SHA.slice(0, 7));
  await expect(facts.review).toContainText("low");
  await expect(facts.cell("review")).toHaveAttribute("title", "one test file changed.");
  // While the ask-user card stands, the merge would leave the task open for
  // that question, and the card says so (INF-2525, docs/forge.md "A
  // requested merge").
  await expect(facts.mergeLine).toHaveText(MERGE_CLOSES_WORDS.continues);

  // 10. The captain answers the finding first. The click is the Firstmate's
  //     turn, served as the captain's choice on its card, and the Firstmate
  //     relays the answer to the builder, which has nothing to change.
  if (!mockProvider) throw new Error("this journey runs on the mock provider");
  const askCard = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.title === MOCK_REVIEW_ASK_CARD_TITLE,
  );
  const keep = askCard?.actions.find((action) => action.label === MOCK_REVIEW_KEEP_LABEL);
  if (!askCard || !keep) throw new Error("the finding card is up with its keep");
  expect(askCard.taskId).toBe(builder.id);
  const kept = mockProvider.scriptFirstmateTurn(
    captainCardChoice(
      { id: askCard.id, title: askCard.title, taskId: builder.id },
      { id: keep.id, label: keep.label },
    ),
    [{ name: "steer_crewmate", args: { task_id: builder.id, message: MOCK_REVIEW_KEEP_STEER } }],
  );
  await showCard(page, MOCK_REVIEW_ASK_CARD_TITLE);
  await shownCard(page, MOCK_REVIEW_ASK_CARD_TITLE)
    .getByRole("button", { name: MOCK_REVIEW_KEEP_LABEL })
    .click();
  // A miss prints the whole outcome: what the Firstmate was served instead.
  await expect
    .poll(kept.outcome, { timeout: 30_000 })
    .toEqual(expect.objectContaining({ state: "closed", results: [expect.any(String)] }));
  await expect(
    reportLine(page, builder.key).filter({ hasText: reportSummary(MOCK_REVIEWED_KEEP_REPORT) }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoCard(page, MOCK_REVIEW_ASK_CARD_TITLE);
  // Nothing else on the task is open now, so the merge closes it.
  await showCard(page, MOCK_REVIEWED_CARD_TITLE);
  await expect(factsStrip(cardBody(page, MOCK_REVIEWED_CARD_TITLE)).mergeLine).toHaveText(
    MERGE_CLOSES_WORDS.closes,
  );

  // 11. The merge: the click asks GitHub for exactly that PR at its head.
  await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
  await expect(putInLine(page, builder.key)).toBeVisible({ timeout: 30_000 });
  // GitHub squashes exactly that change at the reviewed head, under its title.
  expect(github.merges()).toEqual([
    {
      number: 55,
      sha: FINAL_SHA,
      method: "squash",
      title: MOCK_REVIEWED_CHANGE.title,
      message: MOCK_REVIEWED_CHANGE.body,
    },
  ]);
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id))
    .toMatchObject({ status: "done", closedReason: "merged" });

  // The steers reached the builder's session: the auto-fix finding, the
  // re-findings, and the captain's answer on the ask-user finding. What
  // each session's prompt says is piResources.test.ts's, intentBrief.test.ts's
  // and wakes.test.ts's.
  const builderBodies = (mockProvider?.requestBodies() ?? []).filter(
    (body) =>
      !body.includes(FM_SYSTEM_MARKER) &&
      !body.includes(REVIEW_BRIEF_MARKER) &&
      body.includes(REVIEWED_TIER_PROMPT_MARKER),
  );
  expect(builderBodies.some((body) => body.includes(MOCK_REVIEW_AUTOFIX_FINDING))).toBe(true);
  expect(builderBodies.some((body) => body.includes(MOCK_REVIEW_REFIX_STEER))).toBe(true);
  expect(builderBodies.some((body) => body.includes(MOCK_REVIEW_KEEP_STEER))).toBe(true);
  expect(builderBodies.some((body) => body.includes(MOCK_CAP_RETRY_STEER))).toBe(false);

  // Each later step of the review reached the Firstmate on the wake it
  // arises on (FI3-566 cut C), and the builder's brief holds the fix rules
  // the relayed findings are fixed by. Their words are wakes.test.ts's.
  expect(
    builderBodies.some((body) =>
      providerMessages(body).some(
        (message) =>
          message.role === "user" && message.text.includes(renderRigorSection("reviewed")),
      ),
    ),
  ).toBe(true);
  const wakes = servedToFirstmate();
  expect(
    wakes.some(
      (wake) =>
        wake.includes(`reported on review task ${review.id}`) &&
        wake.endsWith(reviewFindingsNext()),
    ),
  ).toBe(true);
  expect(
    wakes.some(
      (wake) =>
        wake.includes(`reported on task ${builder.id}`) &&
        wake.endsWith(
          openReviewText({
            key: review.key,
            verdict: "findings",
            head: HEAD_SHA,
            evidenceRevision: initialProofRevision,
            currentEvidenceRevision: initialProofRevision,
            stateRevision: firstReviewState.assignment?.stateRevision,
            currentStateRevision: firstReviewState.current,
          }),
        ),
    ),
  ).toBe(true);
  expect(
    wakes.some(
      (wake) =>
        wake.includes(`the review of task ${builder.id}`) && wake.endsWith(REVIEW_PASSED_NEXT),
    ),
  ).toBe(true);
});
