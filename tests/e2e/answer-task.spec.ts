import { expect, type Locator, test } from "@playwright/test";
import { renderAnswerShapeSection } from "../../src/core/orchestrator/intentBrief";
import { renderWake } from "../../src/core/orchestrator/wakes";
import { reportSummary } from "../../src/shared/feed";
import type { TaskDetail, TaskView } from "../../src/shared/tasks";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { launchClaudeCrew } from "./claudeCrew";
import { type LaunchedApp, launchApp } from "./launch";
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
import { readSavedData } from "./savedData";
import {
  ANSWER_CONSENT_MARKER,
  ANSWER_CONSENT_TITLE,
  answerConsent,
  CONSENT_ALLOW,
  CONSENT_ALLOWED_STEER,
  CONSENT_CARD_TITLE,
  SIGNED_CARD_TITLE,
  SIGNED_CHOICE,
} from "./scenarios/answerConsent";
import {
  ANSWER_MID_TURN_CARD_TITLE,
  ANSWER_MID_TURN_CHOICE,
  ANSWER_MID_TURN_MARKER,
  ANSWER_MID_TURN_TITLE,
  answerMidTurn,
} from "./scenarios/answerMidTurn";
import {
  ANSWER_READ_MARKER,
  ANSWER_TASK_PROMPT_MARKER,
  answerTask,
  MOCK_ANSWER_ACTION_LABEL,
  MOCK_ANSWER_CARD_TITLE,
  MOCK_ANSWER_FINISHED_AGAIN,
  MOCK_ANSWER_LEAVE_LABEL,
  MOCK_ANSWER_REPORT,
} from "./scenarios/answerTask";
import { OWN_RENT_CARD_TITLE, OWN_RENT_TITLE, ownRentAnswer } from "./scenarios/ownRentAnswer";
import {
  cardLeave,
  cardReply,
  closeEndedCard,
  expectCardSeen,
  shownCard,
  shownEntry,
} from "./stack";

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
  await expect(page.getByRole("button", { name: MOCK_ANSWER_LEAVE_LABEL })).toBeVisible();
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
  await page.screenshot({ path: test.info().outputPath("answer-task-waiting.png") });

  // The captain's choice IS the close (F2 A): the deliverable was produced
  // and reading it is the acknowledgement.
  await page.getByRole("button", { name: MOCK_ANSWER_ACTION_LABEL }).click();
  await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
    status: "done",
    closedReason: "answered",
  });
  await expect(statusLine(page, row.key).filter({ hasText: MOCK_ANSWER_ACTION_LABEL })).toBeVisible(
    { timeout: 30_000 },
  );

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

  const closed = await detail();
  expect(closed.delivery?.prUrl ?? null).toBeNull();
  expect(closed.delivery?.landedMode ?? null).toBeNull();
});

/**
 * INF-1879: putting the answer plan away neither chooses for the captain
 * nor ends its task. Reopening it preserves the explicit choice, whose
 * completion still writes the task's own answered line (INF-1845).
 * Its own app owns every prerequisite.
 */
test("INF-1879: putting an answer plan away keeps its choices and task alive until an explicit choice", async () => {
  const own = await launchApp({
    withMockProvider: true,
    scenarios: [answerTask],
    userDataDir: scratchDir("infinitary-answer-put-away-"),
  });
  const { page } = own;
  try {
    await promptInput(page).fill(`${ANSWER_TASK_PROMPT_MARKER} why does the meter idle?`);
    await promptInput(page).press("Enter");
    await expect(shownCard(page, MOCK_ANSWER_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (card) => card.title === MOCK_ANSWER_CARD_TITLE,
    )!;
    await cardLeave(page).click();
    await expect(shownCard(page, MOCK_ANSWER_CARD_TITLE)).toBeHidden();
    expect(
      await page.evaluate((id) => window.infinitary.tasks.detail(id), card.taskId!),
    ).toMatchObject({ status: "active", closedReason: null });
    expect(
      providerMessages((own.mockProvider?.requestBodies() ?? []).at(-1) ?? "{}").some((message) =>
        message.text.includes("The captain closed your card"),
      ),
    ).toBe(false);
    const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), card.taskId!);
    await expandDock(page, "now");
    await pressRow(page, detail.key);
    await expect(shownCard(page, MOCK_ANSWER_CARD_TITLE)).toBeVisible();
    await shownEntry(page).getByRole("button", { name: MOCK_ANSWER_ACTION_LABEL }).click();
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), card.taskId!))
      .toMatchObject({ status: "done", closedReason: "answered" });
    // INF-1845: an explicit choice closes with its chosen label; plain Answered is for a close without a choice.
    await expect(
      statusLine(page, detail.key).filter({ hasText: MOCK_ANSWER_ACTION_LABEL }),
    ).toBeVisible({ timeout: 30_000 });
    const closed = await page.evaluate((id) => window.infinitary.tasks.detail(id), card.taskId!);
    await test.info().attach("explicit-choice-closed-task", {
      body: JSON.stringify({
        id: closed.id,
        key: closed.key,
        status: closed.status,
        closedReason: closed.closedReason,
      }),
      contentType: "application/json",
    });
    const waiting = nowFrame(page).locator('[data-now-group="waiting"]');
    await expect(waiting.locator(`[data-now-key="${detail.key}"]`)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("answer-close-after.png") });
  } finally {
    await own.close();
  }
});

/**
 * INF-1226: INF-1220 asked the captain's consent to sign a test app, and
 * the captain's allow closed the task answered before anything was signed.
 * A choice on a card its crewmate declared `continues` is not the task's
 * answer: it reaches the crewmate, which goes on to its answer, and the
 * choice on the answer card closes the task. Its own app, so it owns every
 * prerequisite.
 */
test("a choice on an answer task's consent card resumes its crewmate, and the answer card's choice closes it", async () => {
  const own = await launchApp({
    withMockProvider: true,
    scenarios: [answerConsent],
    userDataDir: scratchDir("infinitary-answer-consent-"),
  });
  try {
    const { page, mockProvider } = own;
    // Observe before either card appears so the final click keeps its original ordering.
    const pointerTrace = await page.evaluateHandle(() => {
      const describe = (element: EventTarget | null) => {
        if (!(element instanceof Element)) return null;
        return {
          tag: element.tagName,
          choice: element.closest("[data-card-choice]")?.getAttribute("data-card-choice"),
          stage: element.closest("[data-stage-entry]")?.getAttribute("data-stage-entry"),
        };
      };
      const events: Array<{
        type: string;
        at: number;
        trusted: boolean;
        target: ReturnType<typeof describe>;
        hit: ReturnType<typeof describe>;
      }> = [];
      const record = (event: MouseEvent) => {
        events.push({
          type: event.type,
          at: event.timeStamp,
          trusted: event.isTrusted,
          target: describe(event.target),
          hit: describe(document.elementFromPoint(event.clientX, event.clientY)),
        });
        if (events.length > 24) events.shift();
      };
      for (const type of ["pointerdown", "pointerup", "click"] as const) {
        document.addEventListener(type, record, { capture: true, passive: true });
      }
      return events;
    });
    const input = promptInput(page);
    await input.click();
    await input.fill(`${ANSWER_CONSENT_MARKER} ${ANSWER_CONSENT_TITLE}`);
    await input.press("Enter");

    const consent = shownCard(page, CONSENT_CARD_TITLE);
    await expect(consent).toBeVisible({ timeout: 30_000 });
    const [asked] = await page.evaluate(() => window.infinitary.cards.list());
    if (!asked?.taskId) throw new Error("the consent card names no task");
    const taskId = asked.taskId;
    const detail = async (): Promise<TaskDetail> =>
      page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
    await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
      deliverable: "answer",
      status: "active",
      waitingCardId: asked.id,
    });
    const { key, title } = await detail();

    await consent.getByRole("button", { name: CONSENT_ALLOW.label }).click();
    const signed = shownCard(page, SIGNED_CARD_TITLE);
    await expect(signed).toBeVisible({ timeout: 30_000 });
    expect(await detail()).toMatchObject({ status: "active", closedReason: null });
    expect(
      (mockProvider?.requestBodies() ?? []).some(
        (body) =>
          body.includes("You are a crewmate") &&
          providerMessages(body).some(
            (message) => message.role === "user" && message.text.includes(CONSENT_ALLOWED_STEER),
          ),
      ),
    ).toBe(true);

    const [answer] = await page.evaluate(() => window.infinitary.cards.list());
    if (!answer || answer.taskId !== taskId) throw new Error("the answer card is not the task's");
    try {
      await signed.getByRole("button", { name: SIGNED_CHOICE.label }).click();
      await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
        status: "done",
        closedReason: "answered",
      });
    } catch (failure) {
      const pointer = await pointerTrace
        .jsonValue()
        .catch((error: unknown) => ({ error: String(error) }));
      let saved: unknown;
      try {
        saved = readSavedData(
          own.userDataDir,
          (db) =>
            db
              .prepare<[string], { chosen_action: string | null; resolved_at: number | null }>(
                "SELECT chosen_action, resolved_at FROM cards WHERE id = ?",
              )
              .get(answer.id) ?? null,
        );
      } catch (error) {
        saved = { error: String(error) };
      }
      await test
        .info()
        .attach("answer-close-trace", {
          body: JSON.stringify(
            { cardId: answer.id, expectedChoice: SIGNED_CHOICE.id, pointer, saved },
            null,
            2,
          ),
          contentType: "application/json",
        })
        .catch((error: unknown) => console.warn("Could not attach the answer-close trace:", error));
      throw failure;
    }
    await expect(statusLine(page, key).filter({ hasText: SIGNED_CHOICE.label })).toBeVisible({
      timeout: 30_000,
    });

    // The first mate hears that one close, about the answer, never the consent.
    const told = renderWake({
      facts: {
        kind: "answer-closed",
        handoff: {
          version: 1,
          event: "answer_task_closed",
          task: { id: taskId, key, title },
          card: { id: answer.id, title: SIGNED_CARD_TITLE },
          choice: { ...SIGNED_CHOICE, effect: null },
          close: { status: "done", reason: "answered", actor: "captain" },
        },
      },
    });
    const served = () =>
      (mockProvider?.requestBodies() ?? []).flatMap((body) =>
        providerMessages(body)
          .filter(
            (message) => message.role === "user" && message.text.includes("answer_task_closed"),
          )
          .map((message) => message.text),
      );
    await expect.poll(served, { timeout: 30_000 }).not.toHaveLength(0);
    expect(served().every((text) => text.includes(told))).toBe(true);
  } finally {
    await own.close();
  }
});

/**
 * FI3-1581: the captain acknowledges the answer in its thread. Firstmate
 * puts a note on that task and, in the same turn, settles it answered. The
 * note stays because the captain has not read it; the corner ends no task.
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

    await expectCardSeen(page, MOCK_ANSWER_CARD_TITLE);
    await cardReply(page).field.fill(ANSWER_READ_MARKER);
    await cardReply(page).send.click();
    // Its crewmate ends the answer card the captain had read: it stays,
    // ended, until they close it (INF-3071).
    await closeEndedCard(page, MOCK_ANSWER_CARD_TITLE, { timeout: 30_000 });
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

    await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
      status: "done",
      closedReason: "answered",
    });
    await expect(statusLine(page, key).filter({ hasText: ANSWER_MID_TURN_CHOICE })).toBeVisible({
      timeout: 30_000,
    });
    expect(mockProvider?.heldRequests()).toBe(0);

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
