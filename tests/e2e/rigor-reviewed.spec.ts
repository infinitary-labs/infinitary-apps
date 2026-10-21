import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { renderRigorSection } from "../../src/core/orchestrator/intentBrief";
import {
  REVIEW_NEW_HEAD_NEXT,
  REVIEW_PASSED_NEXT,
  reviewFindingsNext,
} from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { COMPLETION_CARD_HEADINGS } from "../../src/shared/cardHeadings";
import { REVIEW_FINDING_LABEL } from "../../src/shared/cards";
import { reportSummary } from "../../src/shared/feed";
import type { TaskView } from "../../src/shared/tasks";
import { CARE_WORDS, CHECK_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import {
  FM_SYSTEM_MARKER,
  MERGE_PROMPT_MARKER,
  REVIEWED_TIER_PROMPT_MARKER,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { captainCardChoice, latestServedTurn, providerMessages } from "./providerRequest";
import { putInLine, reportLine, startedLine, statusLine, taskLine } from "./rails";
import {
  MOCK_CAP_RETRY_STEER,
  MOCK_REVIEW_ASK_CARD_TITLE,
  MOCK_REVIEW_AUTOFIX_FINDING,
  MOCK_REVIEW_CAP_CARD_TITLE,
  MOCK_REVIEW_CAP_RETRY_LABEL,
  MOCK_REVIEW_REFIX_STEER,
  MOCK_REVIEWED_BUILDER_REPORT,
  MOCK_REVIEWED_CARD_TITLE,
  MOCK_REVIEWED_CHANGE,
  MOCK_REVIEWED_FIX_REPORT,
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
 * with `review_of`; the host briefs the reviewer read-only and holds the
 * builder's merge on a `blocks` edge; the reviewer's findings reach the
 * Firstmate directly (never supervision) and become one steer and one
 * decision card; a merge asked for while the review is open is refused;
 * two re-reviews return findings again and the third findings is one past
 * the review cap (phase 3): the host's one wake becomes the Firstmate's
 * decision card, a further re-review is refused as text, and the captain's
 * answer plus the Firstmate's steer reopen the rounds (`cap_reset`); the
 * captain's next re-review passes, which closes the review task, releases
 * the hold and is one feed line; the completion card then renders with the
 * review beside CI in the host's facts strip, and its merge succeeds.
 *
 * Real: the repository, the task worktrees, the rigor derivation, the
 * review brief, the blocks hold, the verdict parsing, the round counter and
 * its cap, the card path and the settle. Stand-ins: the models (the mock
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

/**
 * The builder's own check_change after it pushes: the app records the head
 * and the green checks on the task, which is what the Firstmate and the
 * review round read (it has no CI tool of its own).
 */
function builderReads(taskId: string, head: string): void {
  const db = openDatabase(userDataDir);
  try {
    // e2e-writer-ok: stands in for the builder's check_change, which the mock builder takes once, on its first report
    new TaskService({ db }).recordDelivery(taskId, {
      ci: "green",
      ciAt: Date.now(),
      headSha: head,
    });
  } finally {
    db.close();
  }
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
 * The Firstmate turns that answered the captain's ask carrying `marker`: a
 * turn counts once a tool result came back (one naming `naming`, when
 * given). `seen` is the count before the ask is sent.
 */
function answeredTurns(marker: string, naming?: string) {
  const count = () =>
    (launched.mockProvider?.requestBodies() ?? []).filter((body) => {
      if (!body.includes(FM_SYSTEM_MARKER)) return false;
      const turn = latestServedTurn(body);
      if (!turn?.segments.some((segment) => segment.body.includes(marker))) return false;
      return turn.toolResults.some((result) => naming === undefined || result.includes(naming));
    }).length;
  return { seen: count(), count };
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
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo-meterlab", repo.repoDir, REPO_NAME, Date.now(), "https://github.com/o/meterlab.git");
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

test("a reviewed task is held by its reviewer until the review passes, then merges with the review on its card", async () => {
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
      blockedBy: [review.key],
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
  await expect(page.getByRole("button", { name: "Keep the copy" })).toBeVisible();
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

  // 5. The hold: a merge asked for while the review is open is refused by
  //    the blocks edge, and nothing was merged. The refusal's words are
  //    crewSupervisor.test.ts's; here the turn has its answer and the task
  //    stays held.
  const merge = answeredTurns(`${MERGE_PROMPT_MARKER}${BUILDER_TITLE}`);
  await input.click();
  await input.fill(`${MERGE_PROMPT_MARKER}${BUILDER_TITLE}`);
  await input.press("Enter");
  await expect.poll(merge.count, { timeout: 30_000 }).toBeGreaterThan(merge.seen);
  expect(github.merges()).toEqual([]);
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id))
    .toMatchObject({ status: "active", closedReason: null });

  // 6. The review cap (phase 3). Two re-reviews return the same finding;
  //    each is a plain steer back to the builder and no card. The third
  //    findings is one past the cap: the host's one wake becomes the
  //    Firstmate's decision card on the builder's task, and the record
  //    says the rounds are spent.
  const detail = () => page.evaluate((id) => window.infinitary.tasks.detail(id), builder.id);
  const roundFixes: Record<number, string> = {
    2: "fix: await the meter snapshot",
    3: "fix: keep the meter steady",
  };
  for (const round of [2, 3]) {
    // The builder's fix moved the head; the mock Firstmate re-reads CI
    // (recording it) before steering the re-review, so the round counts.
    builderReads(builder.id, pushFix(builderBranch, roundFixes[round] as string));
    await input.click();
    await input.fill(REREVIEW_PROMPT_MARKER);
    await input.press("Enter");
    await expect
      .poll(detail, { timeout: 30_000 })
      .toMatchObject({ delivery: expect.objectContaining({ reviewRounds: round }) });
  }
  await expect(
    reportLine(page, builder.key).filter({ hasText: reportSummary(MOCK_REVIEWED_REFIX_REPORT) }),
  ).toBeVisible({ timeout: 30_000 });
  await expect.poll(detail).toMatchObject({
    delivery: expect.objectContaining({ reviewRounds: 3, reviewCapAt: expect.any(Number) }),
  });
  await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: test.info().outputPath("rigor-reviewed-pager.png") });
  await showCard(page, MOCK_REVIEW_CAP_CARD_TITLE);
  await expect(page.getByRole("button", { name: MOCK_REVIEW_CAP_RETRY_LABEL })).toBeVisible();
  await expect(shownCard(page, MOCK_REVIEW_CAP_CARD_TITLE).locator("[data-card-meta]")).toHaveText(
    builder.title,
  );
  await expect(
    shownCard(page, MOCK_REVIEW_CAP_CARD_TITLE).getByText(REVIEW_FINDING_LABEL, { exact: true }),
  ).toHaveCount(0);
  await regionShot(
    shownCard(page, MOCK_REVIEW_CAP_CARD_TITLE),
    test.info().outputPath("task-card-dark.png"),
  );
  // No re-review goes out while the cap holds: the Firstmate's steer to
  // the reviewer is refused (its words are crewSupervisor.test.ts's), so
  // the reviewer's record gains no steer.
  const reviewerSteers = await steersOn(review.id);
  const capped = answeredTurns(REREVIEW_PROMPT_MARKER, review.id);
  await input.click();
  await input.fill(REREVIEW_PROMPT_MARKER);
  await input.press("Enter");
  await expect.poll(capped.count, { timeout: 30_000 }).toBeGreaterThan(capped.seen);
  expect(await steersOn(review.id)).toBe(reviewerSteers);
  await expect.poll(detail).toMatchObject({
    delivery: expect.objectContaining({ reviewRounds: 3, reviewVerdict: "findings" }),
  });

  // 7. The captain's answer on the cap card, relayed by the Firstmate's
  //    steer, reopens the rounds: one cap_reset on the timeline, the
  //    counters cleared, the builder's retry reported. The mock Firstmate
  //    answers only the turn this click serves: the card and the choice as
  //    the app lists them, rendered by the product's own wake renderer.
  const capCard = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.title === MOCK_REVIEW_CAP_CARD_TITLE,
  );
  const retry = capCard?.actions.find((action) => action.label === MOCK_REVIEW_CAP_RETRY_LABEL);
  if (!capCard || !retry) throw new Error("the cap card is up with its retry");
  if (!mockProvider) throw new Error("this journey runs on the mock provider");
  expect(capCard.taskId).toBe(builder.id);
  const capRetry = mockProvider.scriptFirstmateTurn(
    captainCardChoice(
      { id: capCard.id, title: capCard.title, taskId: builder.id },
      { id: retry.id, label: retry.label },
    ),
    [{ name: "steer_crewmate", args: { task_id: builder.id, message: MOCK_CAP_RETRY_STEER } }],
  );
  await page.getByRole("button", { name: MOCK_REVIEW_CAP_RETRY_LABEL }).click();
  // The click's turn was served as the captain's, answered with the one
  // steer, and the steer's result came back. A miss prints the whole
  // outcome: what the Firstmate was served instead.
  await expect
    .poll(capRetry.outcome, { timeout: 30_000 })
    .toEqual(expect.objectContaining({ state: "closed", results: [expect.any(String)] }));
  await expect(
    reportLine(page, builder.key).filter({ hasText: reportSummary(MOCK_REVIEWED_RETRY_REPORT) }),
  ).toBeVisible({ timeout: 30_000 });
  await expect.poll(detail).toMatchObject({
    events: expect.arrayContaining([expect.objectContaining({ kind: "cap_reset" })]),
  });
  const reopened = await detail();
  expect(reopened.delivery?.reviewRounds).toBeUndefined();
  expect(reopened.delivery?.reviewCapAt).toBeUndefined();
  await page.screenshot({ path: test.info().outputPath("rigor-reviewed-retry.png") });

  // 8. The captain's re-review at yet another head: the pass closes the
  //    review task, records the verdict and risk on the builder, releases
  //    the hold, and is one feed line - the builder's own.
  const FINAL_SHA = pushFix(builderBranch, "fix: finish the meter review");
  builderReads(builder.id, FINAL_SHA);
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
  //    beside CI. The ask-user card is the Firstmate's and still stands (the
  //    cap card was answered), so the stack holds two and the new one waits
  //    unread until paged to (WI-18: a new card never steals the shown one).
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

  // 10. The merge: the click asks GitHub for exactly that PR at its head.
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
  // re-findings, and the captain's answer that reopened the rounds. What
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
  expect(builderBodies.some((body) => body.includes(MOCK_CAP_RETRY_STEER))).toBe(true);

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
        wake.endsWith(reviewFindingsNext(true)),
    ),
  ).toBe(true);
  expect(
    wakes.some(
      (wake) =>
        wake.includes(`reported on task ${builder.id}`) &&
        wake.endsWith(
          `Its open review ${review.key} last returned findings at ${HEAD_SHA.slice(0, 7)}. ${REVIEW_NEW_HEAD_NEXT}`,
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
