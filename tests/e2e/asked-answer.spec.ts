import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  ANSWER_MISSING_ENDED_OPENING,
  ANSWER_MISSING_OPENING,
} from "../../src/core/orchestrator/captainWakes";
import {
  REQUESTED_RESPONSE_OPENING,
  RESPONSE_MISSING_OPENING,
} from "../../src/core/orchestrator/reportWakes";
import { closingNoteTitle } from "../../src/core/orchestrator/settleWords";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { openDatabase } from "../../src/core/storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../../src/core/storage/inboxStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { REACT_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { latestServedTurn, toolCallCount } from "./providerRequest";
import { taskKey } from "./rails";
import {
  ANSWER_CARD_TITLE,
  askedAnswer,
  askWords,
  CLOSE_READER,
  FOLLOW_UP,
  METER_CARD_TITLE,
  READER_ANSWER,
  READER_CARD_TITLE,
  READER_TITLE,
  REFUSED_CHANGE,
  REFUSED_CHANGE_HELD,
  RETRY_CARD_TITLE,
  SHOW_THE_METER,
  START_READER,
  START_READER_WITH_CARD,
} from "./scenarios/askedAnswer";
import { showCard } from "./stack";
import { runFromSearch } from "./windowKeys";

/**
 * A question the first mate asks a crewmate for a captain's message ties
 * the message to that question, and a change the app refuses ties it
 * without making the task its work (docs/task-capture.md, "Tied, not its
 * work" and "Waiting for an answer"). Before, a message that asked a
 * running crewmate something was judged only when the whole task closed.
 * Each journey runs the real turn, the real tool layer, the real inbox and
 * the real answer check over a stand-in reader that answers when asked.
 * The one retry is the signal that a message was judged: it is served
 * with the captain's words quoted.
 */

type Turn = { index: number; segments: { kind: string; body: string }[] };

/** The first mate's turns, in order: each served input once, its tool loop's later legs left out. */
function turns(app: LaunchedApp): Turn[] {
  return (app.mockProvider?.requestBodies() ?? []).flatMap((body, index) => {
    if (!body.includes(FIRSTMATE_PERSONA)) return [];
    const turn = latestServedTurn(body);
    if (!turn || turn.toolResults.length > 0) return [];
    return [
      {
        index,
        segments: turn.segments
          .filter((segment) => segment.kind !== "context")
          .map((segment) => ({ kind: segment.kind, body: segment.body })),
      },
    ];
  });
}

const isRetry = (body: string) =>
  body.includes(ANSWER_MISSING_OPENING) || body.includes(ANSWER_MISSING_ENDED_OPENING);

/** The retry turns served for the captain's message `words`. */
const retriesFor = (app: LaunchedApp, words: string) =>
  turns(app).filter((turn) =>
    turn.segments.some((segment) => isRetry(segment.body) && segment.body.includes(`"${words}"`)),
  );

/** The turns that read a saved answer to `question`. */
const answersTo = (app: LaunchedApp, question: string) =>
  turns(app).filter((turn) =>
    turn.segments.some(
      (segment) =>
        segment.body.startsWith(REQUESTED_RESPONSE_OPENING) && segment.body.includes(question),
    ),
  );

/** The turns that read the captain's own `words`, not a wake quoting them. */
const captainTurnsOf = (app: LaunchedApp, words: string) =>
  turns(app).filter((turn) =>
    turn.segments.some(
      (segment) => segment.body.includes(words) && !segment.body.includes("[fm-op]"),
    ),
  );

/** How many of the reader's steps have reported `text`. */
const readerReported = (app: LaunchedApp, text: string) =>
  (app.mockProvider?.requestBodies() ?? []).filter(
    (body) =>
      !body.includes(FIRSTMATE_PERSONA) && body.includes(text) && toolCallCount(body, "report") > 0,
  ).length;

async function say(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** A message the stand-in answers with a reaction, so every earlier turn has finished first. */
async function barrier(page: Page, text: string): Promise<void> {
  await say(page, `${REACT_PROMPT_MARKER}: ${text}`);
  await waitForFirstmateIdle(page);
}

const cardTitles = async (page: Page) =>
  (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title);
const notices = async (page: Page) =>
  (await page.evaluate(() => window.infinitary.cards.list())).filter((card) =>
    card.id.startsWith("card-ask-"),
  );

/** One journey's app, its read-only view of the task record, and its kept turn order. */
async function launch(name: string) {
  const userDataDir = scratchDir(`infinitary-asked-answer-${name}-`);
  const db = openDatabase(userDataDir);
  // TaskService performs boot recovery in its constructor: build it only before launch.
  const tasks = new TaskService({ db });
  const inbox = new InboxStore(db);
  db.pragma("query_only = ON");
  const app = await launchApp({ withMockProvider: true, userDataDir, scenarios: [askedAnswer] });
  const reader = () => tasks.list().find((task) => task.title === READER_TITLE);
  const open = () => {
    const task = reader();
    return task !== undefined && !TaskService.isClosed(task);
  };
  /** Keep the order of the first mate's turns as evidence, each summarized. */
  const keep = () =>
    writeFileSync(
      test.info().outputPath(`${name}-turns.json`),
      JSON.stringify(
        turns(app).map((turn) => ({
          request: turn.index,
          segments: turn.segments.map(
            (segment) => `${segment.kind}: ${segment.body.slice(0, 160)}`,
          ),
        })),
        null,
        2,
      ),
    );
  return { app, page: app.page, tasks, inbox, db, reader, open, keep };
}

/** The captain's first message starts the reader; it reports once before any question. */
async function startReader(app: LaunchedApp, page: Page): Promise<void> {
  await say(page, START_READER);
  await expect
    .poll(() => readerReported(app, "Reading the gas meter."), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await waitForFirstmateIdle(page);
}

test("an answer to a question asked for a message ends its wait while the task stays open", async () => {
  const run = await launch("answer-ends-message");
  try {
    const { app, page } = run;
    await startReader(app, page);
    const words = askWords("quiet", "Does updating install the alpha?");
    await say(page, words);
    // The reader answers; the turn that reads the answer says only closing
    // words, so the message gets its one retry, which shows the answer.
    await expect.poll(() => retriesFor(app, words).length, { timeout: 60_000 }).toBe(1);
    expect(run.open()).toBe(true);
    const [answer] = answersTo(app, "Does updating install the alpha?");
    const [retry] = retriesFor(app, words);
    expect(answer?.index).toBeLessThan(retry?.index ?? -1);
    await expect.poll(() => cardTitles(page), { timeout: 30_000 }).toContain(RETRY_CARD_TITLE);
    await barrier(page, "thanks");
    expect(run.open()).toBe(true);
    expect(retriesFor(app, words)).toHaveLength(1);
    expect(await notices(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("answer-ends-message.png") });
  } finally {
    run.keep();
    await run.app.close();
    run.db.close();
  }
});

test("a card in the answer's turn answers the message, and a follow-up keeps it waiting for its own answer", async () => {
  const run = await launch("card-in-answer-turn");
  try {
    const { app, page } = run;
    await startReader(app, page);

    // Section 1: the turn that reads the answer shows a card; no retry follows.
    const carded = askWords("card", "Is the reading saved?");
    await say(page, carded);
    await expect.poll(() => cardTitles(page), { timeout: 60_000 }).toContain(ANSWER_CARD_TITLE);
    await barrier(page, "thanks for the card");
    expect(retriesFor(app, carded)).toEqual([]);
    expect(await notices(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("card-in-answer-turn.png") });

    // Section 2: that turn asks a follow-up; the message waits for its answer, then ends.
    const followed = askWords("follow", "Does the update keep my settings?");
    await say(page, followed);
    await expect.poll(() => retriesFor(app, followed).length, { timeout: 60_000 }).toBe(1);
    const [first] = answersTo(app, "Does the update keep my settings?");
    const [second] = answersTo(app, FOLLOW_UP);
    const [retry] = retriesFor(app, followed);
    expect(first?.index).toBeLessThan(second?.index ?? -1);
    expect(second?.index).toBeLessThan(retry?.index ?? -1);
    expect(run.open()).toBe(true);
  } finally {
    run.keep();
    await run.app.close();
    run.db.close();
  }
});

test("a question the reader never answers keeps the message waiting until the reader closes", async () => {
  const run = await launch("never-answers");
  try {
    const { app, page } = run;
    await startReader(app, page);
    const words = askWords("hold", "When will the reading finish?");
    await say(page, words);
    await expect
      .poll(() => readerReported(app, "Still reading the gas meter."), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await barrier(page, "take your time");
    expect(
      turns(app).some((turn) => turn.segments[0]?.body.startsWith(RESPONSE_MISSING_OPENING)),
    ).toBe(true);
    expect(run.open()).toBe(true);
    expect(retriesFor(app, words)).toEqual([]);

    const key = await taskKey(page, READER_TITLE);
    await say(page, CLOSE_READER);
    await expect.poll(() => run.open(), { timeout: 60_000 }).toBe(false);
    // The message waits no longer than its reader: the app's one closing
    // note names the reader, a card of the task the message is tied to, so
    // it is the message's answer, with no retry and no notice.
    const noteTitle = closingNoteTitle(key, "dropped");
    await showCard(page, noteTitle);
    await waitForFirstmateIdle(page);
    expect(retriesFor(app, words)).toEqual([]);
    expect(await notices(page)).toEqual([]);
    const note = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (card) => card.title === noteTitle,
    );
    // The captain's Got it on that note accepts it as the message's answer.
    await runFromSearch(app.app, page, "cards.done");
    await expect
      .poll(
        () => run.tasks.capture.listAsks().find((ask) => ask.text === words)?.answerCardId ?? null,
        { timeout: 30_000 },
      )
      .toBe(note?.id ?? "missing");
  } finally {
    run.keep();
    await run.app.close();
    run.db.close();
  }
});

test("two messages asking one reader each wait for their own answer", async () => {
  const run = await launch("two-messages");
  try {
    const { app, page } = run;
    await startReader(app, page);
    const waiting = askWords("hold", "How much gas did we use in May?");
    await say(page, waiting);
    await expect
      .poll(() => readerReported(app, "Still reading the gas meter."), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await waitForFirstmateIdle(page);
    const answered = askWords("quiet", "Is the meter still running?");
    await say(page, answered);
    await expect.poll(() => retriesFor(app, answered).length, { timeout: 60_000 }).toBe(1);
    await barrier(page, "thanks");
    expect(retriesFor(app, waiting)).toEqual([]);
    expect(run.open()).toBe(true);
  } finally {
    run.keep();
    await run.app.close();
    run.db.close();
  }
});

test("a refused change does not make the message wait for the task to close", async () => {
  const run = await launch("refused-change");
  try {
    const { app, page } = run;
    await startReader(app, page);
    await say(page, REFUSED_CHANGE);
    await expect.poll(() => retriesFor(app, REFUSED_CHANGE).length, { timeout: 60_000 }).toBe(1);
    expect(run.open()).toBe(true);
  } finally {
    run.keep();
    await run.app.close();
    run.db.close();
  }
});

test("after a refused change, the task's own card answers the message", async () => {
  const run = await launch("refused-change-card");
  try {
    const { app, page } = run;
    const provider = app.mockProvider;
    if (!provider) throw new Error("no stand-in provider");
    await say(page, START_READER_WITH_CARD);
    // The reader's card is held, then the refused change's first step.
    await expect.poll(() => provider.heldThreadAnswers(), { timeout: 60_000 }).toBe(1);
    await waitForFirstmateIdle(page);
    await say(page, REFUSED_CHANGE_HELD);
    await expect.poll(() => provider.heldThreadAnswers(), { timeout: 60_000 }).toBe(2);
    // The reader's card goes up after the message and before its turn ends.
    provider.releaseThreadAnswer(1);
    await expect.poll(() => cardTitles(page), { timeout: 30_000 }).toContain(READER_CARD_TITLE);
    provider.releaseThreadAnswer();
    await waitForFirstmateIdle(page);
    await barrier(page, "thanks");
    expect(retriesFor(app, REFUSED_CHANGE_HELD)).toEqual([]);
    expect(
      (await notices(page)).filter((card) => card.body.includes("take back the reader")),
    ).toEqual([]);
    expect(run.open()).toBe(true);
    await page.screenshot({ path: test.info().outputPath("refused-change-card.png") });
  } finally {
    run.keep();
    await run.app.close();
    run.db.close();
  }
});

test("an answer is read in a turn of its own, and carry on keeps its message tied", async () => {
  const run = await launch("answer-turn-alone");
  try {
    const { app, page, tasks, inbox } = run;
    const provider = app.mockProvider;
    if (!provider) throw new Error("no stand-in provider");
    await startReader(app, page);
    const question = "Did the reading go through?";
    const words = askWords("carry", question);
    await say(page, words);
    // The asking turn's last step is held until the reader has answered and
    // its turn has ended: its answer and its report both wait on the lane.
    await expect.poll(() => provider.heldThreadAnswers(), { timeout: 60_000 }).toBe(1);
    const waiting = () => inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.facts?.kind);
    await expect
      .poll(waiting, { timeout: 60_000 })
      .toEqual(expect.arrayContaining(["requested-response", "report"]));
    provider.releaseThreadAnswer();
    // The turn that reads the answer is held at its carry-on steer.
    await expect.poll(() => answersTo(app, question).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(() => provider.heldThreadAnswers(), { timeout: 60_000 }).toBe(1);
    // The captain writes while the answer's turn runs.
    await say(page, SHOW_THE_METER);
    await expect
      .poll(() => tasks.capture.listAsks().some((ask) => ask.text === SHOW_THE_METER), {
        timeout: 30_000,
      })
      .toBe(true);
    provider.releaseThreadAnswer();
    await expect.poll(() => retriesFor(app, words).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(() => cardTitles(page), { timeout: 60_000 }).toContain(METER_CARD_TITLE);
    const reports = () =>
      turns(app).filter((turn) =>
        turn.segments.some(
          (segment) =>
            segment.body.includes("reported on task") && segment.body.includes(READER_ANSWER),
        ),
      );
    await expect.poll(() => reports().length, { timeout: 60_000 }).toBeGreaterThan(0);
    await waitForFirstmateIdle(page);

    // The answer was read alone: no other wake and no captain's words beside it.
    const answers = answersTo(app, question);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.segments).toHaveLength(1);
    // The report that waited beside it was served in a later turn.
    expect(reports()[0]?.index).toBeGreaterThan(answers[0]?.index ?? Number.MAX_SAFE_INTEGER);
    // The carry-on steer kept the tie: the retry came while the reader is open.
    expect(run.open()).toBe(true);
    // The captain's words came after the answer's turn and its retry, in a turn of their own.
    const [retry] = retriesFor(app, words);
    const [shown] = captainTurnsOf(app, SHOW_THE_METER);
    expect(answers[0]?.index).toBeLessThan(retry?.index ?? -1);
    expect(retry?.index).toBeLessThan(shown?.index ?? -1);
    expect(
      shown?.segments.some((segment) => segment.body.startsWith(REQUESTED_RESPONSE_OPENING)),
    ).toBe(false);
    // Their card answered their own message, not the earlier one.
    expect(retriesFor(app, SHOW_THE_METER)).toEqual([]);
    expect(await notices(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("answer-turn-alone.png") });
  } finally {
    run.keep();
    await run.app.close();
    run.db.close();
  }
});
