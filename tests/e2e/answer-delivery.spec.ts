import { expect, type Page, test } from "@playwright/test";
import { ANSWER_NOTICE_TITLE } from "../../src/core/orchestrator/answerDelivery";
import { ANSWER_MISSING_OPENING } from "../../src/core/orchestrator/wakes";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TITLE,
  REACT_PROMPT_MARKER,
  RETRY_ACTS_MARKER,
  RETRY_ANSWER_TITLE,
  RETRY_SILENT_MARKER,
  SILENT_ANSWER_MARKER,
  startMockProvider,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { latestServedTurn } from "./providerRequest";

/**
 * Answer delivery (docs/task-capture.md "Answer delivery"): for each captain
 * message, did an action take effect after Firstmate read it? One output-only
 * retry follows a message nothing took effect after, then one notice. The
 * mock Firstmate answers a message with hidden closing words only when the
 * captain says so (`SILENT_ANSWER_MARKER`); everything else it answers with a
 * reaction, a card or work, as a model does. These journeys run the real
 * turn, the real tool layer, the real inbox and the real host card.
 */

async function say(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function cards(page: Page) {
  return page.evaluate(() => window.infinitary.cards.list());
}

const notices = async (page: Page) =>
  (await cards(page)).filter((card) => card.id.startsWith("card-ask-"));

/**
 * How many retry turns the mock provider has been served: a request whose
 * newest input is the retry's wake and that follows no tool result of its own.
 * The history a later request carries never counts again.
 */
const retriesServed = (app: LaunchedApp) =>
  (app.mockProvider?.requestBodies() ?? []).filter((body) => {
    const turn = latestServedTurn(body);
    return (
      turn !== undefined &&
      turn.toolResults.length === 0 &&
      turn.segments.some((segment) => segment.body.includes(ANSWER_MISSING_OPENING))
    );
  }).length;

/** A message the mock answers with a reaction, so every earlier turn has finished first. */
async function barrier(page: Page, text: string): Promise<void> {
  await say(page, `${REACT_PROMPT_MARKER}: ${text}`);
  await waitForFirstmateIdle(page);
}

test("a message nothing took effect after gets one retry that shows the answer, with no notice", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    await say(page, `${SILENT_ANSWER_MARKER}: what is the plan?`);
    await expect
      .poll(async () => (await cards(page)).map((card) => card.title), { timeout: 30_000 })
      .toEqual([RETRY_ANSWER_TITLE]);
    await barrier(page, "thanks");
    // One answer, no notice, and the closing words the model said stayed hidden.
    const shown = await cards(page);
    expect(shown.filter((card) => card.title === RETRY_ANSWER_TITLE)).toHaveLength(1);
    expect(await notices(page)).toEqual([]);
    expect(JSON.stringify(shown)).not.toContain("HIDDEN closing words");
    expect(JSON.stringify(shown)).not.toContain("alert(1)");
    expect(retriesServed(app)).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("answer-after-retry.png") });
  } finally {
    await app.close();
  }
});

test("a retry that shows nothing raises one notice quoting only the captain's words, and Ask again sends the message once more", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    const words = `${SILENT_ANSWER_MARKER}, ${RETRY_SILENT_MARKER}: ship <b>it</b>`;
    await say(page, words);
    await expect.poll(async () => (await notices(page)).length, { timeout: 30_000 }).toBe(1);
    const [first] = await notices(page);
    expect(first).toMatchObject({ title: ANSWER_NOTICE_TITLE, author: "host" });
    expect(first?.actions.find((action) => action.default)?.label).toBe("Ask again");
    // The captain's own words, escaped; never the closing words or any markup of the model's.
    expect(first?.body).toContain("ship &lt;b&gt;it&lt;/b&gt;");
    expect(first?.body).not.toContain("HIDDEN");
    expect(first?.body).not.toContain("<script>");
    expect(JSON.stringify(await cards(page))).not.toContain("alert(1)");
    await page.screenshot({ path: test.info().outputPath("notice.png") });

    // No second retry or notice follows by itself.
    const served = retriesServed(app);
    await barrier(page, "hello again");
    expect((await notices(page)).map((card) => card.id)).toEqual([first?.id]);
    expect(retriesServed(app)).toBe(served);

    // Ask again is a fresh message of the captain's: it runs the same turn, and the
    // first notice is gone while the new message has its own.
    await page.getByRole("button", { name: "Ask again", exact: true }).click();
    await expect
      .poll(
        async () => {
          const ids = (await notices(page)).map((card) => card.id);
          return ids.length === 1 && ids[0] !== first?.id;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const [second] = await notices(page);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.body).toContain("ship &lt;b&gt;it&lt;/b&gt;");

    // Leave it closes the notice and runs nothing.
    const before = retriesServed(app);
    await page.getByRole("button", { name: "Leave it", exact: true }).click();
    await expect.poll(async () => (await notices(page)).length).toBe(0);
    await barrier(page, "all good");
    expect(retriesServed(app)).toBe(before);
    expect(await notices(page)).toEqual([]);
  } finally {
    await app.close();
  }
});

test("the retry only shows an answer: work it tries to start is refused and the message ends in the notice", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    const workTasks = async () =>
      (await page.evaluate(() => window.infinitary.tasks.board())).tasks.filter(
        (task) => task.kind === "work",
      );
    expect(await workTasks()).toEqual([]);
    await say(page, `${SILENT_ANSWER_MARKER}, ${RETRY_ACTS_MARKER}: look into the meter`);
    await expect.poll(async () => (await notices(page)).length, { timeout: 30_000 }).toBe(1);
    await barrier(page, "thanks");
    // The refused call put nothing on the record, and nothing was started.
    expect(await workTasks()).toEqual([]);
    expect((await notices(page)).length).toBe(1);
  } finally {
    await app.close();
  }
});

test("a message answered by a card or a reaction is never retried", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    await say(page, `${ANSWER_PROMPT_MARKER} how much quota is left?`);
    await expect
      .poll(async () => (await cards(page)).map((card) => card.title), { timeout: 30_000 })
      .toEqual([MOCK_ANSWER_TITLE]);
    await barrier(page, "thanks, that is all");
    expect(retriesServed(app)).toBe(0);
    expect(await notices(page)).toEqual([]);
    expect((await cards(page)).map((card) => card.title)).toEqual([MOCK_ANSWER_TITLE]);
  } finally {
    await app.close();
  }
});

test("a restart after the notice keeps the count: no second retry and no second notice", async () => {
  const userDataDir = scratchDir("infinitary-answer-delivery-");
  const mockProvider = await startMockProvider();
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchApp({ reuseMockProvider: mockProvider, userDataDir });
    await say(launched.page, `${SILENT_ANSWER_MARKER}, ${RETRY_SILENT_MARKER}: still there?`);
    await expect
      .poll(async () => (await notices(launched?.page as Page)).length, { timeout: 30_000 })
      .toBe(1);
    const [notice] = await notices(launched.page);
    const served = retriesServed(launched);
    await launched.close();
    launched = undefined;

    launched = await launchApp({ reuseMockProvider: mockProvider, userDataDir });
    // The same one notice is still up (the host's saved card), and a new
    // message proves nothing queued itself behind the restart.
    await expect
      .poll(async () => (await notices(launched?.page as Page)).map((card) => card.id), {
        timeout: 30_000,
      })
      .toEqual([notice?.id]);
    await barrier(launched.page, "hello after the restart");
    expect((await notices(launched.page)).map((card) => card.id)).toEqual([notice?.id]);
    expect(retriesServed(launched)).toBe(served);
  } finally {
    await launched?.close();
    await mockProvider.close();
  }
});
