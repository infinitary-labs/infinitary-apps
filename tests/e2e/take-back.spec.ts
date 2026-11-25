import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { ANSWER_NOTICE_TITLE } from "../../src/core/orchestrator/answerDelivery";
import {
  ANSWER_MISSING_OPENING,
  TAKEN_BACK_OPENING,
  TAKEN_BACK_REPLACED,
} from "../../src/core/orchestrator/captainWakes";
import { takenBackRefusalText } from "../../src/core/orchestrator/takeBack";
import * as m from "../../src/shared/i18n/messages.generated";
import { waitForFirstmateIdle } from "./crew";
import { conversation, conversationYou, mateBubble, yourBubble } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { SILENT_ANSWER_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  TAKE_BACK_ALONE_MARKER,
  TAKE_BACK_FILED_MARKER,
  TAKE_BACK_HELD_MARKER,
  TAKE_BACK_UNDO_LINE,
  TAKE_BACK_UNRELATED_TITLE,
  takeBack,
  takeBackAlone,
} from "./scenarios/takeBack";
import { runFromSearch } from "./windowKeys";

/**
 * Taking back a message in the app's core (docs/task-capture.md, "Taking
 * back a message"), from INF-6763's approved plan, part 1: the captain takes
 * back their newest message within one minute; a turn still reading it is
 * refused every action credited to it, and once a turn acted on it the first
 * mate is served one wake listing what it caused, by task key, to undo.
 * Driven through the window's bridge with a scripted first mate. Part 2,
 * the desktop's controls: a revert icon beside the newest message, Up to
 * replace it, the command, and the marks the strip and conversation draw.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

async function start(): Promise<LaunchedApp> {
  launched = await launchApp({ scenarios: [takeBack, takeBackAlone], withMockProvider: true });
  await expect(promptInput(launched.page)).toBeEnabled({ timeout: 30_000 });
  return launched;
}

const send = (page: Page, turn: string | { text: string; replaces: string }) =>
  page.evaluate((sent) => window.infinitary.conversation.send(sent), turn);

/** The newest message's id once the core saved the message whose words are `words`. */
async function newestAsk(page: Page, words: string): Promise<string> {
  const read = () =>
    page.evaluate(async () => {
      const turn = await window.infinitary.conversation.lastTurn();
      return { you: turn?.you, askId: turn?.askId };
    });
  await expect.poll(async () => (await read()).you, { timeout: 30_000 }).toBe(words);
  const { askId } = await read();
  expect(askId).toBeTruthy();
  return askId as string;
}

const takeBackAsk = (page: Page, askId: string) =>
  page.evaluate((id) => window.infinitary.conversation.takeBack(id), askId);

async function task(page: Page, title: string) {
  return page.evaluate(
    async (wanted) =>
      (await window.infinitary.tasks.board()).tasks.find((row) => row.title === wanted),
    title,
  );
}

/** The newest request the first mate's stand-in received that holds `words`. */
const requestWith = (app: LaunchedApp, words: string) =>
  (app.mockProvider?.requestBodies() ?? []).filter((body) => body.includes(words)).at(-1);

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a message taken back while its turn reads it files nothing for it", async ({}, testInfo) => {
  const app = await start();
  const title = "delete the old build logs";
  const words = `${TAKE_BACK_HELD_MARKER} ${title}`;
  await send(app.page, words);
  const askId = await newestAsk(app.page, words);
  await expect.poll(() => app.mockProvider?.heldThreadAnswers(), { timeout: 30_000 }).toBe(1);

  expect(await takeBackAsk(app.page, askId)).toEqual({ outcome: "stopping" });
  app.mockProvider?.releaseThreadAnswer();

  // The words up to the first quote, which a request body escapes.
  const refused = takenBackRefusalText(askId).split('"')[0] ?? "";
  await expect.poll(() => requestWith(app, refused) ?? null, { timeout: 30_000 }).not.toBeNull();
  writeFileSync(testInfo.outputPath("refused-request.json"), requestWith(app, refused) ?? "");
  await waitForFirstmateIdle(app.page);
  expect(await task(app.page, title)).toBeUndefined();
  // A call that names no message with ask_id "" goes through.
  expect(await task(app.page, TAKE_BACK_UNRELATED_TITLE)).toBeDefined();
  expect(await takeBackAsk(app.page, askId)).toEqual({ outcome: "refused", reason: "taken-back" });
  // Nothing took effect for the message, yet a taken-back message gets no answer retry or notice.
  expect(requestWith(app, ANSWER_MISSING_OPENING)).toBeUndefined();
  const cards = await app.page.evaluate(() => window.infinitary.cards.list());
  expect(cards.map((card) => card.title)).not.toContain(ANSWER_NOTICE_TITLE);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a message waiting unread while the first mate answers alone is withdrawn and never served", async ({}, testInfo) => {
  const app = await start();
  await send(app.page, `${TAKE_BACK_ALONE_MARKER} ${SILENT_ANSWER_MARKER}`);
  // The answer retry is served alone and held, so a new message waits on the lane.
  await expect.poll(() => app.mockProvider?.heldThreadAnswers(), { timeout: 30_000 }).toBe(1);
  const words = "archive the release notes from last year";
  await send(app.page, words);
  const askId = await newestAsk(app.page, words);
  expect(await takeBackAsk(app.page, askId)).toEqual({ outcome: "withdrawn" });
  app.mockProvider?.releaseThreadAnswer();
  await waitForFirstmateIdle(app.page);
  const bodies = app.mockProvider?.requestBodies() ?? [];
  writeFileSync(testInfo.outputPath("requests-after-withdraw.json"), JSON.stringify(bodies));
  expect(bodies.filter((body) => body.includes(words))).toEqual([]);
  expect(requestWith(app, TAKEN_BACK_OPENING)).toBeUndefined();
  expect(await takeBackAsk(app.page, askId)).toEqual({ outcome: "refused", reason: "taken-back" });
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a message taken back after its turn filed a task has the first mate discard it", async ({}, testInfo) => {
  const app = await start();
  const title = "rename the release channel";
  const words = `${TAKE_BACK_FILED_MARKER} ${title}`;
  await send(app.page, words);
  const askId = await newestAsk(app.page, words);
  await expect
    .poll(async () => (await task(app.page, title))?.status, { timeout: 30_000 })
    .toBe("open");
  await waitForFirstmateIdle(app.page);
  const filed = await task(app.page, title);

  expect(await takeBackAsk(app.page, askId)).toEqual({ outcome: "undoing" });
  const opening = `${TAKEN_BACK_OPENING} ${askId}`;
  await expect.poll(() => requestWith(app, opening) ?? null, { timeout: 30_000 }).not.toBeNull();
  const wake = requestWith(app, opening) ?? "";
  writeFileSync(testInfo.outputPath("taken-back-wake.json"), wake);
  expect(wake).toContain(`create_task on task ${filed?.id} (${filed?.key})`);
  await expect
    .poll(async () => (await task(app.page, title))?.status, { timeout: 30_000 })
    .toBe("dropped");
  await waitForFirstmateIdle(app.page);
  // Each wake served stays in the conversation, so the newest request holds every one.
  const newest = app.mockProvider?.requestBodies().at(-1) ?? "";
  expect(newest.split(opening).length - 1).toBe(1);
  expect(await takeBackAsk(app.page, askId)).toEqual({ outcome: "refused", reason: "taken-back" });
  const turn = await app.page.evaluate(() => window.infinitary.conversation.lastTurn());
  expect(turn?.takenBack).toBe(true);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a replacement takes back the newest message and its words reach the undo", async ({}, testInfo) => {
  const app = await start();
  const title = "move the nightly backup to Sunday";
  const words = `${TAKE_BACK_FILED_MARKER} ${title}`;
  await send(app.page, words);
  const first = await newestAsk(app.page, words);
  await expect
    .poll(async () => (await task(app.page, title))?.status, { timeout: 30_000 })
    .toBe("open");
  await waitForFirstmateIdle(app.page);

  const replacement = "keep the nightly backup on Saturday and tell me when it last ran";
  await send(app.page, { text: replacement, replaces: first });
  const second = await newestAsk(app.page, replacement);
  const replaced = `${TAKEN_BACK_REPLACED} \\"${replacement}\\"`;
  await expect.poll(() => requestWith(app, replaced) ?? null, { timeout: 30_000 }).not.toBeNull();
  writeFileSync(testInfo.outputPath("replaced-wake.json"), requestWith(app, replaced) ?? "");
  await waitForFirstmateIdle(app.page);
  const turn = await app.page.evaluate(() => window.infinitary.conversation.lastTurn());
  expect(turn?.askId).toBe(second);
  expect(turn?.previous).toMatchObject({ askId: first, takenBack: true });
  expect(await takeBackAsk(app.page, first)).toEqual({ outcome: "refused", reason: "taken-back" });

  await send(app.page, "what is on the backlog?");
  await newestAsk(app.page, "what is on the backlog?");
  expect(await takeBackAsk(app.page, second)).toEqual({ outcome: "refused", reason: "not-newest" });
});

/** Sends `words` through the main input, as a person does, and waits for its turn to end. */
async function type(page: Page, words: string): Promise<string> {
  await promptInput(page).fill(words);
  await promptInput(page).press("Enter");
  const askId = await newestAsk(page, words);
  await waitForFirstmateIdle(page);
  return askId;
}

// INF-6763's approved plan, part 2, and the captain's words on it: "don't
// make the button literally "take back". use a "revert" icon or something
// like that".
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("the revert icon beside the newest message takes it back and its line says what was undone", async ({}, testInfo) => {
  const { page } = await start();
  const title = "rename the release channel";
  await type(page, `${TAKE_BACK_FILED_MARKER} ${title}`);
  await expect.poll(async () => (await task(page, title))?.status).toBe("open");

  const revert = page.locator("[data-last-turn-revert]");
  await yourBubble(page).hover();
  await expect(revert).toHaveAccessibleName(m.shellLastTurnRevert());
  await expect(revert).toHaveText("");
  await revert.click();

  await expect
    .poll(async () => (await task(page, title))?.status, { timeout: 30_000 })
    .toBe("dropped");
  await waitForFirstmateIdle(page);
  await expect(page.locator("[data-last-turn] [data-last-turn-reverted]")).toHaveText(
    m.shellLastTurnReverted(),
  );
  await expect(revert).toHaveCount(0);
  // The undo turn read no message: its line stands on the message taken back.
  const line = await page.evaluate(() => window.infinitary.conversation.lastTurn());
  writeFileSync(testInfo.outputPath("last-turn-after-revert.json"), JSON.stringify(line));
  expect(line?.reply?.text).toBe(TAKE_BACK_UNDO_LINE);
  await expect(mateBubble(page)).toHaveText(TAKE_BACK_UNDO_LINE);

  await mateBubble(page).click();
  await expect(conversation(page)).toBeVisible();
  await expect(conversation(page).locator("[data-conversation-reverted]")).toHaveCount(1);
  await expect(conversationYou(page).last()).toHaveAttribute("data-taken-back", "");
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("Up inside the minute marks the draft as replacing the newest message, Esc sends it as new", async ({}, testInfo) => {
  const { page } = await start();
  const title = "move the nightly backup to Sunday";
  const first = await type(page, `${TAKE_BACK_FILED_MARKER} ${title}`);
  const input = promptInput(page);
  const mark = page.locator("[data-voice-input-replaces]");

  await input.press("ArrowUp");
  await expect(input).toHaveValue(`${TAKE_BACK_FILED_MARKER} ${title}`);
  await expect(mark).toHaveText(m.composerReplacesLast());
  await expect(page.locator("[data-prompt-dock]")).toContainText(m.composerHintSendsAsNew());
  await input.press("Escape");
  await expect(mark).toHaveCount(0);
  await expect(input).toHaveValue(`${TAKE_BACK_FILED_MARKER} ${title}`);

  await input.fill("");
  await input.press("ArrowUp");
  await expect(mark).toBeVisible();
  const replacement = "keep the nightly backup on Saturday";
  await input.fill(replacement);
  await expect(mark).toBeVisible();
  await input.press("Enter");
  const second = await newestAsk(page, replacement);
  await expect
    .poll(async () => (await task(page, title))?.status, { timeout: 30_000 })
    .toBe("dropped");
  await waitForFirstmateIdle(page);
  const turn = await page.evaluate(() => window.infinitary.conversation.lastTurn());
  writeFileSync(testInfo.outputPath("last-turn-after-replace.json"), JSON.stringify(turn));
  expect(turn?.askId).toBe(second);
  expect(turn?.previous).toMatchObject({ askId: first, takenBack: true });

  await yourBubble(page).click();
  await expect(conversation(page)).toBeVisible();
  const edited = conversation(page).locator("[data-conversation-edited]");
  await expect(edited.locator("summary")).toHaveText(m.shellConversationEdited());
  await edited.locator("summary").click();
  await expect(edited.locator("[data-conversation-replaced]")).toHaveText(
    `${TAKE_BACK_FILED_MARKER} ${title}`,
  );
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("the revert command from search takes back the newest message, and refuses once it is", async ({}) => {
  const { app, page } = await start();
  const askId = await type(page, "what is on the backlog today?");
  await runFromSearch(app, page, "message.take-back");
  await expect
    .poll(
      async () => (await page.evaluate(() => window.infinitary.conversation.lastTurn()))?.takenBack,
    )
    .toBe(true);
  expect(await takeBackAsk(page, askId)).toEqual({ outcome: "refused", reason: "taken-back" });
  await expect(page.locator("[data-last-turn] [data-last-turn-reverted]")).toBeVisible();
});
