import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { planSkippedText } from "../../src/shared/routingPolicy";
import type { TaskDetail, TaskView } from "../../src/shared/tasks";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import {
  SEQ_BUG_NO,
  SEQ_BUG_NO_ASK,
  SEQ_BUG_SHOWN,
  SEQ_BUG_SHOWN_ASK,
  SEQ_BUG_YES,
  SEQ_BUG_YES_ASK,
  SEQ_CHECKED,
  SEQ_CHECKED_ASK,
  SEQ_FEATURE,
  SEQ_FEATURE_ASK,
  SEQ_IMPLEMENT_AMENDED_GOAL,
  SEQ_IMPLEMENT_CARD_TITLE,
  SEQ_IMPLEMENT_LINE,
  SEQ_NOT_REPRODUCED_TITLE,
  SEQ_NOT_REPRODUCED_WAYS,
  SEQ_PLAN_CARD_BODY,
  SEQ_PLAN_CARD_TITLE,
  SEQ_PLAN_CHOICE,
  SEQ_PLAN_FINAL_SPEC,
  SEQ_PLAN_LINE,
  SEQ_PROTOTYPE,
  SEQ_PROTOTYPE_ASK,
  SEQ_PROTOTYPE_BUILD_GOAL,
  SEQ_PROTOTYPE_CARD_BODY,
  SEQ_PROTOTYPE_CARD_TITLE,
  SEQ_PROTOTYPE_CHOICE,
  SEQ_PROTOTYPE_PLAN_GOAL,
  SEQ_PROTOTYPE_SPEC,
  SEQ_REPRODUCED_YES,
  SEQ_SAVED,
  SEQ_SAVED_ASK,
  SEQ_SAVED_CARD_BODY,
  SEQ_SAVED_CARD_TITLE,
  SEQ_SAVED_CHOICE,
  SEQ_SAVED_SPEC,
  SEQ_SHOWN_REPRO_TITLE,
  SEQ_SMALL,
  SEQ_SMALL_ASK,
  SEQ_SMALL_PLAN_SKIP,
  SEQ_START_SHOWN_FIX,
  SEQ_THREAD_ANSWER,
  SEQ_THREAD_REPLY,
} from "./mockProvider";
import { promptInput } from "./prompt";
import {
  expandDock,
  expectRecordBar,
  expectRecordBody,
  feedLine,
  hideRecord,
  nowFrame,
  nowRowGroup,
  openGroup,
  pressRow,
  recordBarButton,
  recordCard,
  recordFrame,
  rowAtRest,
  startedLine,
  statusLine,
} from "./rails";
import { cardReply, showCard, shownCard, shownCardFrame, shownEntry } from "./stack";

/**
 * Sequences (docs/sequences.md, contracts v4.6 and v4.19): an ask of more
 * than one step becomes an ordinary parent task with child steps (a
 * one-step ask is one task with no parent), and every hand-off between the
 * steps runs through primitives the host already has - a planned child
 * naming its basis, `update_task start_policy: when-ready` on the wake the Firstmate
 * already gets, the basis section in the next step's brief, and a parent no
 * crewmate holds closing with its last child.
 *
 * The mock Firstmate follows the served instructions by script (the point
 * is the host's record, the hand-off, the brief and the parent's close,
 * not the model's judgment); everything else is the real app: the real
 * Firstmate turn and tools, real crewmate sessions, the real card chrome
 * and click, the real settle, the real now panel.
 */

let launched: LaunchedApp;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = scratchDir("infinitary-sequences-");
  launched = await launchApp({ withMockProvider: true, userDataDir });
});

test.afterAll(async () => {
  await launched.close();
});

async function ask(page: Page, words: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(words);
  await input.press("Enter");
}

async function board(page: Page): Promise<TaskView[]> {
  return (await page.evaluate(() => window.infinitary.tasks.board())).tasks;
}

/** A row by its exact title, once it is on the board. */
async function rowTitled(page: Page, title: string): Promise<TaskView> {
  let found: TaskView | undefined;
  await expect
    .poll(
      async () => {
        found = (await board(page)).find((task) => task.title === title);
        return found?.id ?? null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  return found as TaskView;
}

function detailOf(page: Page, id: string): () => Promise<TaskDetail> {
  return () => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
}

/** The first brief a crewmate was served that carries `needle`. */
async function servedBrief(needle: string): Promise<string> {
  const find = () =>
    (launched.mockProvider?.requestBodies() ?? []).find(
      (body) => body.includes("You are a crewmate") && body.includes(needle),
    );
  await expect.poll(() => find() ?? null, { timeout: 30_000 }).not.toBeNull();
  return JSON.stringify(JSON.parse(find() as string));
}

/**
 * The card a served brief hands over as a file (FI3-700), read the way the
 * crewmate opens it. The brief is the served request's JSON text, so its
 * line breaks are escaped.
 */
function handedCard(brief: string): { file: string; body: string } {
  const file = /open it to read the card:\\n- ([^"\\]+)/.exec(brief)?.[1];
  if (!file) throw new Error("the served brief names no card file");
  return { file, body: readFileSync(file, "utf8") };
}

/** A card by title, once it is on the stack, paged to the front. */
async function cardShown(page: Page, title: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (card) => card.title === title,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  // A lone card has no pager; page only when the stack holds more than one.
  if ((await page.evaluate(() => window.infinitary.cards.list())).length > 1) {
    await showCard(page, title);
  }
  await expect(shownCard(page, title)).toBeVisible({ timeout: 30_000 });
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a feature ask: plan, the captain's choice, the grounded implement step, and the parent's close", async ({}, testInfo) => {
  const { page } = launched;
  await ask(page, SEQ_FEATURE_ASK);

  // The record: a parent with no crewmate, the plan step running as an
  // answer, the implement step on request with the plan as its basis.
  const parent = await rowTitled(page, SEQ_FEATURE.parent);
  const plan = await rowTitled(page, SEQ_FEATURE.plan);
  const implement = await rowTitled(page, SEQ_FEATURE.implement);
  const parentDetail = detailOf(page, parent.id);
  const planDetail = detailOf(page, plan.id);
  const implementDetail = detailOf(page, implement.id);
  await expect.poll(parentDetail, { timeout: 30_000 }).toMatchObject({
    status: "open",
    startPolicy: "on-request",
    assignee: null,
  });
  await expect.poll(planDetail, { timeout: 30_000 }).toMatchObject({
    status: "active",
    parentId: parent.id,
    deliverable: "answer",
  });
  expect(await implementDetail()).toMatchObject({
    status: "open",
    parentId: parent.id,
    startPolicy: "on-request",
  });

  // The planner's proposal card; the captain says a word under it, then
  // chooses. The choice is what tells the Firstmate the next step's turn
  // has come.
  await cardShown(page, SEQ_PLAN_CARD_TITLE);
  const reply = cardReply(page).field;
  await reply.click();
  await reply.fill(SEQ_THREAD_REPLY);
  await cardReply(page).send.click();
  await expect(shownEntry(page).getByText(SEQ_THREAD_ANSWER)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await planDetail()).outcome, { timeout: 30_000 })
    .toBe(SEQ_PLAN_FINAL_SPEC);
  // Settings edited immediately before approval reach the closed answer's builder.
  const frame = cardBody(page, SEQ_PLAN_CARD_TITLE);
  await frame.locator("#sample-count").fill("4");
  const offeredCardId = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.title === SEQ_PLAN_CARD_TITLE,
  )?.id;
  if (!offeredCardId) throw new Error("plan offer disappeared");
  const answers = shownCardFrame(page).getByLabel("One per task");
  await answers.evaluate((element) => (element as HTMLInputElement).click());
  const evidenceDir = testInfo.outputPath("approval-handoff");
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/accepted-plan.png` });
  await page.screenshot({ path: testInfo.outputPath("saved-choices.png") });
  await page.getByRole("button", { name: SEQ_PLAN_CHOICE }).click();
  await expect.poll(planDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });

  // The Firstmate started the implement step on that wake, grounded: its
  // basis answered, so the served brief carries what the plan established.
  await expect.poll(implementDetail, { timeout: 30_000 }).toMatchObject({ status: "active" });
  const brief = await servedBrief("Implement the accepted direction for the settings page");
  expect(brief).toContain("q2_count:");
  expect(brief).toContain("many");
  // A repeated delivered click has no remaining card; no extra implementation starts.
  const closedCardId = offeredCardId;
  await page.evaluate((id) => window.infinitary.cards.act(id, "group", "chrome"), closedCardId);
  expect((await board(page)).filter((task) => task.title === SEQ_FEATURE.implement)).toHaveLength(
    1,
  );
  writeFileSync(`${evidenceDir}/served-brief.json`, brief);
  writeFileSync(`${evidenceDir}/task-state.json`, JSON.stringify(await implementDetail(), null, 2));

  expect(brief).toContain(`Goal: ${SEQ_IMPLEMENT_AMENDED_GOAL}`);
  expect(brief).toContain(`grounded in ${plan.key}`);
  // The plan's card reaches the builder whole, as a file it opens; the
  // brief names the file and pastes none of the card's markup.
  const handed = handedCard(brief);
  expect(handed.body).toBe(SEQ_PLAN_CARD_BODY);
  expect(brief).not.toContain("<legend>How many records?</legend>");
  writeFileSync(`${evidenceDir}/handed-card.json`, JSON.stringify(handed, null, 2));
  // The receipt is pinned independently of later planner/builder reports.
  const pinned = (await implementDetail()).events.find((event) => event.kind === "briefed");
  expect(pinned?.text).toContain(SEQ_IMPLEMENT_AMENDED_GOAL);
  expect(pinned?.text).toContain(SEQ_PLAN_FINAL_SPEC);
  writeFileSync(
    testInfo.outputPath("spec-receipt.json"),
    JSON.stringify(
      {
        servedRequest: JSON.parse(brief),
        pinned: pinned?.text,
        amendedGoal: (await implementDetail()).goal,
      },
      null,
      2,
    ),
  );
  // The plan step recorded the final agreed spec - the captain's tweak
  // included - and that record, with his choice, is what the implementer
  // starts from.
  expect(brief).toContain(SEQ_PLAN_FINAL_SPEC);
  expect(brief).toContain(`The captain closed it by choosing \\"${SEQ_PLAN_CHOICE}\\".`);
  expect(brief).toContain(`- captain: ${SEQ_THREAD_REPLY}`);
  expect(brief).toContain(JSON.stringify('sample-count: "4", changed').slice(1, -1));
  // The document's implement line reached the crewmate word for word, as a
  // constraint under the captain's words, which outrank it.
  const words = brief.indexOf(
    `outrank every elaboration below, including your own:\\n${SEQ_FEATURE_ASK}`,
  );
  const relayed = brief.indexOf(`Constraints:\\n- ${SEQ_IMPLEMENT_LINE}`);
  expect(words).toBeGreaterThan(-1);
  expect(relayed).toBeGreaterThan(words);
  // The plan step was an answer: its scratch copy is gone and nothing was
  // saved from it, so the brief names no working copy to start from.
  expect(brief).not.toContain("Its work is on branch");
  expect(brief).not.toContain("its work is saved in the repository");

  // The implement step's completion card; the captain puts the work in.
  await cardShown(page, SEQ_IMPLEMENT_CARD_TITLE);
  await expect(
    cardBody(page, SEQ_IMPLEMENT_CARD_TITLE).getByRole("heading", { name: "After", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/implementation-started.png` });

  await page.getByRole("button", { name: MERGE_WORDS.land, exact: true }).click();
  await expect.poll(implementDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "landed",
  });

  // The parent had nothing of its own to settle: it closes with its last
  // child, and says so once.
  await expect.poll(parentDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "finished",
  });
  await expect(statusLine(page, parent.key)).toBeVisible({ timeout: 30_000 });
  await expandDock(page, "now");
  const landed = nowFrame(page).locator('[data-now-group-header="landed"]');
  await landed.evaluate((el) => (el as HTMLElement).click());
  await expect(
    nowFrame(page).locator('[data-now-group="landed"]').locator(`[data-now-key="${parent.key}"]`),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: test.info().outputPath("sequences-feature-landed.png") });
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a plan saved for later: Save and defer files its build on request, and Start builds it from the plan", async ({}, testInfo) => {
  const { page } = launched;
  await ask(page, SEQ_SAVED_ASK);

  // A plan asked for on its own: one read-only step, an answer, no parent.
  const plan = await rowTitled(page, SEQ_SAVED.plan);
  const planDetail = detailOf(page, plan.id);
  await expect.poll(planDetail, { timeout: 30_000 }).toMatchObject({
    status: "active",
    parentId: null,
    deliverable: "answer",
  });

  // The ready plan ends in three choices; the captain picks an answer, then
  // keeps the plan for later.
  await cardShown(page, SEQ_SAVED_CARD_TITLE);
  await shownCardFrame(page)
    .getByLabel("At the bottom")
    .evaluate((element) => (element as HTMLInputElement).click());
  await page.screenshot({ path: testInfo.outputPath("saved-plan-card.png") });
  await page.getByRole("button", { name: SEQ_SAVED_CHOICE, exact: true }).click();
  await expect.poll(planDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });

  // The Firstmate filed one build on request, grounded on the plan, and
  // started nothing: it waits in the backlog with no crewmate.
  const build = await rowTitled(page, SEQ_SAVED.build);
  const buildDetail = detailOf(page, build.id);
  await expect(feedLine(page, new RegExp(SEQ_SAVED.build))).toBeVisible({ timeout: 30_000 });
  expect(await buildDetail()).toMatchObject({
    status: "open",
    startPolicy: "on-request",
    assignee: null,
    parentId: null,
  });
  expect((await board(page)).filter((task) => task.title === SEQ_SAVED.build)).toHaveLength(1);
  await expandDock(page, "now");
  await openGroup(page, "backlog");
  await expect.poll(() => nowRowGroup(page, build.key), { timeout: 30_000 }).toBe("backlog");
  await rowAtRest(page, build.key);
  await page.screenshot({ path: testInfo.outputPath("saved-build-planned.png") });

  // Its record offers the captain's Start; his press starts it.
  await pressRow(page, build.key);
  await expect(recordCard(page)).toHaveAttribute("data-task-record", build.id);
  await expectRecordBody(page);
  expect(await expectRecordBar(page)).toMatchObject({ next: "start" });
  await page.screenshot({ path: testInfo.outputPath("saved-build-record.png") });
  await recordBarButton(page, "next").click();
  await expect.poll(buildDetail, { timeout: 30_000 }).toMatchObject({ status: "active" });

  // The builder starts from the saved plan: its recorded spec, the card
  // whole, the answer picked and the choice, under the captain's words.
  const brief = await servedBrief("Build the calmer about page the saved plan agreed");
  writeFileSync(testInfo.outputPath("saved-build-brief.json"), brief);
  expect(brief).toContain(`grounded in ${plan.key}`);
  expect(brief).toContain(SEQ_SAVED_SPEC);
  expect(brief).toContain(`The captain closed it by choosing \\"${SEQ_SAVED_CHOICE}\\".`);
  expect(brief).toContain(JSON.stringify('version_line: "At the bottom" (bottom)').slice(1, -1));
  expect(handedCard(brief).body).toBe(SEQ_SAVED_CARD_BODY);
  const words = brief.indexOf(
    `outrank every elaboration below, including your own:\\n${SEQ_SAVED_ASK}`,
  );
  expect(words).toBeGreaterThan(-1);
  expect(brief.indexOf(`Constraints:\\n- ${SEQ_IMPLEMENT_LINE}`)).toBeGreaterThan(words);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("an ask for a prototype is a plan whose card is a playable preview, and Approve and build hands its setting to the builder", async ({}, testInfo) => {
  const { page } = launched;
  await ask(page, SEQ_PROTOTYPE_ASK);

  // The plan line the Firstmate was served sends the ask to one read-only
  // plan step, no parent, and reaches its crewmate word for word.
  const plan = await rowTitled(page, SEQ_PROTOTYPE.plan);
  const planDetail = detailOf(page, plan.id);
  await expect.poll(planDetail, { timeout: 30_000 }).toMatchObject({
    status: "active",
    parentId: null,
    deliverable: "answer",
  });
  expect((await planDetail()).intent?.constraints).toEqual([
    { kind: "read-only" },
    { kind: "free", text: SEQ_PLAN_LINE },
  ]);
  const planBrief = await servedBrief(SEQ_PROTOTYPE_PLAN_GOAL);
  expect(planBrief).toContain(
    "When I ask for a prototype, a mock-up or to try something, it is this plan with a playable preview as the card",
  );
  writeFileSync(testInfo.outputPath("prototype-plan-brief.json"), planBrief);

  // Its card is the preview.
  await cardShown(page, SEQ_PROTOTYPE_CARD_TITLE);

  // The captain tries another tilt: the preview moves and stages the setting.
  const frame = cardBody(page, SEQ_PROTOTYPE_CARD_TITLE);
  await frame.locator("#tilt").evaluate((input: HTMLInputElement) => {
    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(frame.locator("#reading")).toHaveText("42°");
  await page.screenshot({ path: testInfo.outputPath("prototype-plan-card.png") });
  await page.getByRole("button", { name: SEQ_PROTOTYPE_CHOICE, exact: true }).click();

  // The click closes the answer; the control never reached its author.
  await expect.poll(planDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });
  expect((await planDetail()).events.filter((event) => event.kind === "steered")).toHaveLength(0);

  // The Firstmate starts one builder grounded on the plan; its brief carries
  // the card whole as a file, the choice and the staged setting.
  const build = await rowTitled(page, SEQ_PROTOTYPE.build);
  await expect.poll(detailOf(page, build.id), { timeout: 30_000 }).toMatchObject({
    status: "active",
    parentId: null,
  });
  expect((await board(page)).filter((task) => task.title === SEQ_PROTOTYPE.build)).toHaveLength(1);
  const brief = await servedBrief(SEQ_PROTOTYPE_BUILD_GOAL);
  writeFileSync(testInfo.outputPath("prototype-build-brief.json"), brief);
  expect(brief).toContain(`grounded in ${plan.key}`);
  expect(brief).toContain(SEQ_PROTOTYPE_SPEC);
  expect(brief).toContain(`The captain closed it by choosing \\"${SEQ_PROTOTYPE_CHOICE}\\".`);
  expect(brief).toContain(JSON.stringify('look: {"tiltDeg":42} (JSON), changed').slice(1, -1));
  expect(handedCard(brief).body).toBe(SEQ_PROTOTYPE_CARD_BODY);
  const words = brief.indexOf(
    `outrank every elaboration below, including your own:\\n${SEQ_PROTOTYPE_ASK}`,
  );
  expect(words).toBeGreaterThan(-1);
  expect(brief.indexOf(`Constraints:\\n- ${SEQ_IMPLEMENT_LINE}`)).toBeGreaterThan(words);
  await page.screenshot({ path: testInfo.outputPath("prototype-build-started.png") });
});

test("a single-place change declares its plan skip: one running task, no parent", async () => {
  const { page } = launched;
  const before = (await board(page)).map((task) => task.id);
  await ask(page, SEQ_SMALL_ASK);
  const implement = await rowTitled(page, SEQ_SMALL.implement);
  await expect.poll(detailOf(page, implement.id), { timeout: 30_000 }).toMatchObject({
    status: "active",
    parentId: null,
    skippedPlanBecause: SEQ_SMALL_PLAN_SKIP,
  });
  await expect(feedLine(page, planSkippedText(SEQ_SMALL_PLAN_SKIP))).toBeVisible();
  // The ask is that one task: nothing else was filed for it.
  const added = (await board(page)).filter((task) => !before.includes(task.id));
  expect(added.map((task) => task.title)).toEqual([SEQ_SMALL.implement]);
  await pressRow(page, implement.key);
  const record = recordFrame(page);
  await record
    .locator('[data-record-section="words"] > summary')
    .evaluate((el) => (el as HTMLElement).click());
  await expect(record.locator("[data-record-plan-skip]")).toHaveText(SEQ_SMALL_PLAN_SKIP);
  await page.screenshot({ path: test.info().outputPath("sequences-direct-build.png") });
  await hideRecord(page).click();
});

test("a bug that reproduces: the fix starts on the reproduction, and the reproduce step closes answered", async () => {
  const { page } = launched;
  await ask(page, SEQ_BUG_YES_ASK);
  const parent = await rowTitled(page, SEQ_BUG_YES.parent);
  const reproduce = await rowTitled(page, SEQ_BUG_YES.reproduce);
  const fix = await rowTitled(page, SEQ_BUG_YES.fix);
  const fixDetail = detailOf(page, fix.id);
  const reproduceDetail = detailOf(page, reproduce.id);
  // The reproduce step is an answer: the Firstmate declares it read-only, as its guide says.
  await expect.poll(reproduceDetail, { timeout: 30_000 }).toMatchObject({
    deliverable: "answer",
  });

  // "reproduced: yes" is the Firstmate's cue: the fix starts grounded on
  // the reproduction...
  await expect.poll(fixDetail, { timeout: 30_000 }).toMatchObject({
    status: "active",
    parentId: parent.id,
  });
  const brief = await servedBrief("Fix the meter reset at its root");
  expect(brief).toContain(`grounded in ${reproduce.key}`);
  expect(brief).toContain(SEQ_REPRODUCED_YES);
  // An answer's scratch copy holds nothing of its answer: no branch is named.
  expect(brief).not.toContain("Its work is on branch");

  // ...and the reproduce step, a step the Firstmate ran, closes as answered:
  // its answer was used, never thrown away.
  await expect.poll(reproduceDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });
  // Its line names the task its answer carries on in.
  await expect(statusLine(page, reproduce.key)).toContainText(fix.key, { timeout: 30_000 });
  const feed = await page.evaluate(() => window.infinitary.feed.recent());
  for (const line of feed.filter((entry) => entry.text.includes(SEQ_BUG_YES.reproduce))) {
    expect(line.text).not.toMatch(/discard/i);
    expect(line.kind).not.toBe("warn");
  }
  // Closing state above proves the answer was retained; a pinned brief may
  // legitimately explain that the answer task's scratch copy is discarded.
  // A step the Firstmate runs was told its report is the answer handed on.
  expect(await servedBrief("Reproduce the meter reset")).toContain(
    "Your report is that answer and is handed to the next step verbatim",
  );
  // The ask itself lives on with its fix.
  expect(await detailOf(page, parent.id)()).toMatchObject({ status: "open" });
});

test("a check the build waits on closes answered into the build, and the build is no longer held", async () => {
  const { page } = launched;
  await ask(page, SEQ_CHECKED_ASK);
  const build = await rowTitled(page, SEQ_CHECKED.build);
  const check = await rowTitled(page, SEQ_CHECKED.check);
  const buildDetail = detailOf(page, build.id);
  const checkDetail = detailOf(page, check.id);
  // The build is under way, and the check is a step of the Firstmate's own
  // that the build waits on: while it is live it holds the build's merge.
  await expect.poll(checkDetail, { timeout: 30_000 }).toMatchObject({
    deliverable: "answer",
    blocks: [build.key],
  });

  // The check passes, and the Firstmate closes it as answered: nothing names
  // it as a basis, but the build that waited on it is where its answer went.
  await expect.poll(checkDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });
  await expect(statusLine(page, check.key)).toContainText(build.key, { timeout: 30_000 });
  const feed = await page.evaluate(() => window.infinitary.feed.recent());
  for (const line of feed.filter((entry) => entry.text.includes(SEQ_CHECKED.check))) {
    expect(line.text).not.toMatch(/discard/i);
    expect(line.kind).not.toBe("warn");
  }
  // The wait cleared as done: the build carries on and nothing holds its merge.
  expect(await buildDetail()).toMatchObject({
    status: "active",
    blockedBy: [],
    flags: { blocked: false },
  });
});

test("a repro the captain asked to see is his: the Firstmate leaves it, and his click closes it", async () => {
  const { page } = launched;
  await ask(page, SEQ_BUG_SHOWN_ASK);
  const reproduce = await rowTitled(page, SEQ_BUG_SHOWN.reproduce);
  const fix = await rowTitled(page, SEQ_BUG_SHOWN.fix);
  const reproduceDetail = detailOf(page, reproduce.id);
  // His own ask lands as a card, the way his questions always have.
  expect(await servedBrief("Reproduce the clock drift")).toContain("it lands as one card");
  await cardShown(page, SEQ_SHOWN_REPRO_TITLE);

  // He says to start the fix before choosing: the fix starts, and the
  // Firstmate leaves the repro alone - it is his, not a step of its own.
  await ask(page, SEQ_START_SHOWN_FIX);
  await expect.poll(detailOf(page, fix.id), { timeout: 30_000 }).toMatchObject({
    status: "active",
  });
  await expect(startedLine(page, fix.key)).toBeVisible({ timeout: 30_000 });
  expect(await reproduceDetail()).toMatchObject({ status: "active" });
  await expect(shownCard(page, SEQ_SHOWN_REPRO_TITLE)).toBeVisible();

  // His click is its close.
  await page.getByRole("button", { name: "Fix it", exact: true }).click();
  await expect.poll(reproduceDetail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });
  const close = (await reproduceDetail()).events.find(
    (event) => (event.data as { reason?: string } | null)?.reason === "answered",
  );
  expect(close).toMatchObject({ actor: "captain", text: 'chose "Fix it"' });
});

test("a bug that does not reproduce: the owner shows the decision and no fix starts", async () => {
  const { page } = launched;
  await ask(page, SEQ_BUG_NO_ASK);
  const reproduce = await rowTitled(page, SEQ_BUG_NO.reproduce);
  const fix = await rowTitled(page, SEQ_BUG_NO.fix);
  await cardShown(page, SEQ_NOT_REPRODUCED_TITLE);
  for (const way of SEQ_NOT_REPRODUCED_WAYS) {
    await expect(page.getByRole("button", { name: way, exact: true })).toBeVisible();
  }
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  expect(cards.filter((card) => card.title === SEQ_NOT_REPRODUCED_TITLE)).toHaveLength(1);
  expect(cards.find((card) => card.title === SEQ_NOT_REPRODUCED_TITLE)).toMatchObject({
    taskId: reproduce.id,
    author: "crewmate",
  });
  expect(cards.some((card) => card.taskId === reproduce.id && card.author === "firstmate")).toBe(
    false,
  );
  expect(await detailOf(page, fix.id)()).toMatchObject({ status: "open" });
});
