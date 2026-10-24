import { expect, type Locator, test } from "@playwright/test";
import { renderAnswerShapeSection } from "../../src/core/orchestrator/intentBrief";
import { renderWake } from "../../src/core/orchestrator/wakes";
import { reportSummary } from "../../src/shared/feed";
import type { TaskDetail, TaskView } from "../../src/shared/tasks";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { launchClaudeCrew } from "./claudeCrew";
import { type LaunchedApp, launchApp } from "./launch";
import { CARD_CLOSED_STEER_NEEDLE } from "./mockProvider";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import {
  expandDock,
  expectRecordTaskStatus,
  nowFrame,
  pressRow,
  recordCard,
  reportLine,
  startedLine,
  statusLine,
  taskKey,
} from "./rails";
import {
  ANSWER_MID_TURN_CARD_TITLE,
  ANSWER_MID_TURN_CHOICE,
  ANSWER_MID_TURN_MARKER,
  ANSWER_MID_TURN_TITLE,
  answerMidTurn,
} from "./scenarios/answerMidTurn";
import {
  ANSWER_TASK_PROMPT_MARKER,
  answerTask,
  MOCK_ANSWER_ACTION_LABEL,
  MOCK_ANSWER_CARD_TITLE,
  MOCK_ANSWER_FINISHED_REPORT,
  MOCK_ANSWER_REPORT,
} from "./scenarios/answerTask";
import { OWN_RENT_CARD_TITLE, OWN_RENT_TITLE, ownRentAnswer } from "./scenarios/ownRentAnswer";
import { expectNoCard, shownCard, shownEntry } from "./stack";

/**
 * The deliverable axis (crew-posture rationalization Task B, captain
 * rulings F1-F4 of 2026-09-20). An answer task is a first-class fact on the
 * record: derived by the host from the typed `read-only` constraint, told
 * the truth in its brief - no delivery line, no rigor tier, a worktree it
 * commits nothing from - and CLOSED `done/answered` when the captain
 * resolves the one card that is its deliverable.
 *
 * Everything here runs through the real Firstmate turn, a real crewmate
 * session, the real emit -> lint -> frame path and a real card click; the
 * mock provider supplies only the two models' words.
 */

const ANSWER_TITLE = "why the meter idles";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [ownRentAnswer, answerTask],
    userDataDir: scratchDir("infinitary-answer-task-"),
  });
});

test.afterAll(async () => {
  await launched.close();
});

/** Chromium drops native clicks into a hidden window's sandboxed frames. */
async function clickInFrame(target: Locator): Promise<void> {
  await target.evaluate((el) => (el as HTMLElement).click());
}

test("an answer task is briefed as shipping nothing, waits on its card, and closes done/answered", async () => {
  const { page, mockProvider } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${ANSWER_TASK_PROMPT_MARKER} ${ANSWER_TITLE}`);
  await input.press("Enter");

  await expect(startedLine(page, await taskKey(page, ANSWER_TITLE))).toBeVisible({
    timeout: 30_000,
  });

  const rowOf = async (): Promise<TaskView | null> => {
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    return board.tasks.find((task) => task.title === ANSWER_TITLE) ?? null;
  };
  await expect.poll(async () => (await rowOf())?.key ?? null, { timeout: 30_000 }).not.toBeNull();
  const row = await rowOf();
  if (!row) throw new Error("the answer task never reached the board");
  const detail = async (): Promise<TaskDetail> =>
    page.evaluate((id) => window.infinitary.tasks.detail(id), row.id);

  // The record carries the axis: the deliverable the host derived, and NO
  // rigor at all - a task that ships nothing takes no tier.
  await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
    deliverable: "answer",
    rigor: null,
  });

  // The brief the crewmate was actually SERVED says it ships nothing and its
  // worktree is scratch, with no rigor tier anywhere in it.
  const served = await expect
    .poll(
      () =>
        (mockProvider?.requestBodies() ?? []).find(
          (body) => body.includes("You are a crewmate") && body.includes("Find out why the meter"),
        ) ?? null,
      { timeout: 30_000 },
    )
    .not.toBeNull()
    .then(
      () =>
        (mockProvider?.requestBodies() ?? []).find(
          (body) => body.includes("You are a crewmate") && body.includes("Find out why the meter"),
        ) as string,
    );
  const servedBrief = providerMessages(served).find((message) => message.role === "user")?.text;
  expect(servedBrief).toContain(renderAnswerShapeSection());

  // The answer lands as ONE decision card whose actions are exactly the two
  // the crewmate declared - never a host-attached merge/discard pair, which
  // the card boundary refuses on an answer task.
  await expect(shownCard(page, MOCK_ANSWER_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: MOCK_ANSWER_ACTION_LABEL })).toBeVisible();
  await expect(page.getByRole("button", { name: "Leave it for now" })).toBeVisible();
  for (const shipped of [...Object.values(MERGE_WORDS), "Discard"]) {
    await expect(page.getByRole("button", { name: shipped })).toHaveCount(0);
  }
  // The report is one feed line beside it, never a second card.
  await expect(
    reportLine(page, row.key).filter({ hasText: reportSummary(MOCK_ANSWER_REPORT) }),
  ).toBeVisible({ timeout: 30_000 });

  // The now panel has it waiting on the captain while the card is up. The
  // open panel carries no counts line (the filter moved into its header),
  // so the waiting group itself is the evidence: this task is reachable there.
  await expandDock(page, "now");
  const frame = nowFrame(page);
  const waiting = frame.locator('[data-now-group="waiting"]');
  await expect(waiting.locator(`[data-now-key="${row.key}"]`)).toBeVisible({ timeout: 30_000 });
  // Product evidence: the answer on the stage, the row waiting on the rail.
  await page.screenshot({ path: test.info().outputPath("answer-task-waiting.png") });

  // The captain's choice IS the close (F2 A): the deliverable was produced
  // and reading it is the acknowledgement.
  await page.getByRole("button", { name: MOCK_ANSWER_ACTION_LABEL }).click();
  await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });
  // The close is the task's own line, naming the choice.
  await expect(statusLine(page, row.key).filter({ hasText: MOCK_ANSWER_ACTION_LABEL })).toBeVisible(
    { timeout: 30_000 },
  );

  // ...and the row moves from "waiting on you" to "landed", where the record
  // reads the word the panel's own vocabulary gives it.
  await expect(waiting).toHaveCount(0, { timeout: 30_000 });
  // Landed is one of the groups the minimal panel collapses to a count, so
  // the row is there and the group has to be opened to see it.
  const landed = frame.locator('[data-now-group-header="landed"]');
  await expect(landed.locator("[data-now-count]")).toHaveText("1", { timeout: 30_000 });
  await clickInFrame(landed);
  await expect(
    frame.locator('[data-now-group="landed"]').locator(`[data-now-key="${row.key}"]`),
  ).toBeVisible({ timeout: 30_000 });
  await pressRow(page, row.key);
  const pane = recordCard(page);
  await expect(pane.getByText(row.key, { exact: true })).toBeVisible();
  await expectRecordTaskStatus(page);
  // The record pane sizes to its content and only then clamps into the
  // window (`paneGeometry.ts`: a row near the bottom of a tall panel must
  // not push the pane off the window). Wait for that measurement to settle,
  // so the assertion reads the clamp rather than a mid-measure frame - and
  // so the evidence image shows what the captain sees.
  let settled = { top: -1, bottom: -1 };
  await expect
    .poll(
      async () => {
        const box = await recordCard(page).boundingBox();
        const height = await page.evaluate(() => window.innerHeight);
        if (!box) return false;
        const now = { top: box.y, bottom: box.y + box.height };
        const stable = now.top === settled.top && now.bottom === settled.bottom;
        settled = now;
        return stable && now.bottom <= height;
      },
      { timeout: 15_000, intervals: [250, 250, 250, 500] },
    )
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath("answer-task-answered.png") });

  // Nothing shipped: no pull request, nothing landed, and the scratch
  // worktree is gone with the close.
  const closed = await detail();
  expect(closed.delivery?.prUrl ?? null).toBeNull();
  expect(closed.delivery?.landedAt ?? null).toBeNull();
});

/**
 * The captain's close of the answer card is not a choice (FI3-435, his
 * answer "Send it to the crewmate like every other card"): it reaches the
 * crewmate that wrote it, which judges the answer read and reports it
 * finished, and the Firstmate closes the task answered on that report.
 * Its own app, so it owns every prerequisite.
 */
test("closing the answer card reaches its crewmate, which reports it finished, and Firstmate closes it answered", async () => {
  const own = await launchApp({
    withMockProvider: true,
    scenarios: [ownRentAnswer, answerTask],
    userDataDir: scratchDir("infinitary-answer-close-"),
  });
  try {
    const { page, mockProvider } = own;
    const title = "why the gauge drifts";
    const input = promptInput(page);
    await input.click();
    await input.fill(`${ANSWER_TASK_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    await expect(shownCard(page, MOCK_ANSWER_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const row = board.tasks.find((task) => task.title === title);
    if (!row) throw new Error("the answer task never reached the board");
    const detail = async (): Promise<TaskDetail> =>
      page.evaluate((id) => window.infinitary.tasks.detail(id), row.id);

    // Its card up: waiting on the captain.
    await expandDock(page, "now");
    const waiting = nowFrame(page).locator('[data-now-group="waiting"]');
    await expect(waiting.locator(`[data-now-key="${row.key}"]`)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("answer-close-before.png") });

    // The captain closes the card without choosing.
    await shownEntry(page).locator('button[aria-label="Close"]').first().click();
    await expectNoCard(page, MOCK_ANSWER_CARD_TITLE);

    // The close reached the crewmate as its next turn; it reported the
    // answer read and finished; the Firstmate closed the task on that.
    await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
      status: "done",
      closedReason: "answered",
    });
    const { events } = await detail();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "steered", actor: "captain" }),
        expect.objectContaining({
          kind: "report",
          text: MOCK_ANSWER_FINISHED_REPORT,
          actor: "crewmate",
        }),
      ]),
    );
    // In that order: the close, then the crewmate's word.
    const steered = events.findIndex(
      (event) => event.kind === "steered" && event.actor === "captain",
    );
    const reported = events.findIndex((event) => event.text === MOCK_ANSWER_FINISHED_REPORT);
    expect(steered).toBeGreaterThanOrEqual(0);
    expect(reported).toBeGreaterThan(steered);
    expect(
      (mockProvider?.requestBodies() ?? []).some(
        (body) => body.includes("You are a crewmate") && body.includes(CARD_CLOSED_STEER_NEEDLE),
      ),
    ).toBe(true);
    await expect(
      reportLine(page, row.key).filter({ hasText: reportSummary(MOCK_ANSWER_FINISHED_REPORT) }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(waiting.locator(`[data-now-key="${row.key}"]`)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("answer-close-after.png") });
  } finally {
    await own.close();
  }
});

/**
 * FI3-1581: the captain closes the crewmate's answer card. Firstmate puts a
 * note on that task and, in the same turn, closes the task answered. The
 * note stays, because the captain has not closed it.
 */
test("a Firstmate note on an answer task stays up after settle_task answered", async () => {
  const own = await launchApp({
    withMockProvider: true,
    scenarios: [ownRentAnswer, answerTask],
    userDataDir: scratchDir("infinitary-answer-note-stays-"),
  });
  try {
    const { page } = own;
    const title = `${OWN_RENT_TITLE} for Mac CI`;
    const input = promptInput(page);
    await input.click();
    await input.fill(`${ANSWER_TASK_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    await expect(shownCard(page, MOCK_ANSWER_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const row = board.tasks.find((task) => task.title === title);
    if (!row) throw new Error("the answer task never reached the board");
    const detail = async (): Promise<TaskDetail> =>
      page.evaluate((id) => window.infinitary.tasks.detail(id), row.id);

    await shownEntry(page).locator('button[aria-label="Close"]').first().click();
    await expectNoCard(page, MOCK_ANSWER_CARD_TITLE);
    await expect(shownCard(page, OWN_RENT_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
      status: "done",
      closedReason: "answered",
    });
    // The failing check from the reproduction: the note is still shown after the close.
    await expect(shownCard(page, OWN_RENT_CARD_TITLE)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("answer-note-stays.png") });
    await heroShot(own.app, page, {
      region: shownEntry(page),
      name: "answer-card-stays",
      dir: test.info().outputPath("hero"),
    });
  } finally {
    await own.close();
  }
});

/**
 * INF-721 friction 1: the captain chooses on an answer task's card while its
 * crewmate is still working. The choice stops that turn to close the task,
 * and the stopped turn's end is not a cancel: the task closes answered and
 * the first mate hears the choice, once. INF-648's 11:21 AM choice closed
 * cancelled and never reached the first mate. Its own app, on the Claude
 * crew, whose stand-in holds the crewmate's next step open.
 */
test("a choice on an answer card while its crewmate works closes it answered and reaches the first mate", async () => {
  const own = await launchClaudeCrew({ scenarios: [answerMidTurn, answerTask] });
  let taskId: string | undefined;
  try {
    const { page, mockProvider } = own;
    const input = promptInput(page);
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.click();
    await input.fill(`${ANSWER_MID_TURN_MARKER} ${ANSWER_MID_TURN_TITLE}`);
    await input.press("Enter");

    // The card is up and the crewmate's turn still runs: its next step
    // waits on the model.
    await expect(shownCard(page, ANSWER_MID_TURN_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => mockProvider?.heldRequests(), { timeout: 30_000 }).toBe(1);
    const [card] = await page.evaluate(() => window.infinitary.cards.list());
    if (!card?.taskId) throw new Error("the answer card names no task");
    taskId = card.taskId;
    const detail = async (): Promise<TaskDetail> =>
      page.evaluate((id) => window.infinitary.tasks.detail(id), card.taskId as string);
    await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
      deliverable: "answer",
      status: "active",
      activity: "running",
      waitingCardId: card.id,
    });
    const { key, title } = await detail();
    await page.screenshot({ path: test.info().outputPath("answer-mid-turn-before.png") });

    await page.getByRole("button", { name: ANSWER_MID_TURN_CHOICE }).click();

    // The choice is the close: answered, never cancelled.
    await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
      status: "done",
      closedReason: "answered",
    });
    await expect(statusLine(page, key).filter({ hasText: ANSWER_MID_TURN_CHOICE })).toBeVisible({
      timeout: 30_000,
    });
    expect(mockProvider?.heldRequests()).toBe(0);

    // The first mate is served the choice it closed on, once.
    const told = renderWake({
      facts: {
        kind: "answer-closed",
        handoff: {
          version: 1,
          event: "answer_task_closed",
          task: { id: card.taskId, key, title },
          card: { id: card.id, title: card.title },
          choice: { id: "free-and-restart", label: ANSWER_MID_TURN_CHOICE, effect: null },
          close: { status: "done", reason: "answered", actor: "captain" },
        },
      },
    });
    const heard = () =>
      (mockProvider?.requestBodies() ?? [])
        .map(
          (body) =>
            providerMessages(body).filter(
              (message) => message.role === "user" && message.text.includes(told),
            ).length,
        )
        .filter((count) => count > 0);
    await expect.poll(heard, { timeout: 30_000 }).not.toHaveLength(0);
    expect(heard().every((count) => count === 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("answer-mid-turn-after.png") });
  } finally {
    // What the record says and every answer_task_closed the first mate was served.
    if (taskId)
      await test.info().attach("answer-mid-turn.json", {
        body: JSON.stringify(
          {
            task: await own.page.evaluate((id) => window.infinitary.tasks.detail(id), taskId),
            served: (own.mockProvider?.requestBodies() ?? []).flatMap((body) =>
              providerMessages(body)
                .filter((message) => message.text.includes("answer_task_closed"))
                .map((message) => message.text),
            ),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    await own.close();
  }
});
