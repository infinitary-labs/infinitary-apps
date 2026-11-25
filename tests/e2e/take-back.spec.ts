import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { TAKEN_BACK_OPENING, TAKEN_BACK_REPLACED } from "../../src/core/orchestrator/captainWakes";
import { takenBackRefusalText } from "../../src/core/orchestrator/takeBack";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { promptInput } from "./prompt";
import { TAKE_BACK_FILED_MARKER, TAKE_BACK_HELD_MARKER, takeBack } from "./scenarios/takeBack";

/**
 * Taking back a message in the app's core (docs/task-capture.md, "Taking
 * back a message"), from INF-6763's approved plan, part 1: the captain takes
 * back their newest message within one minute; a turn still reading it is
 * refused every action credited to it, and once a turn acted on it the first
 * mate is served one wake listing what it caused, by task key, to undo.
 * Driven through the window's bridge with a scripted first mate; the
 * control a person presses belongs to the desktop part.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

async function start(): Promise<LaunchedApp> {
  launched = await launchApp({ scenarios: [takeBack], withMockProvider: true });
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
test("a message taken back while its turn reads it files nothing", async ({}, testInfo) => {
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
