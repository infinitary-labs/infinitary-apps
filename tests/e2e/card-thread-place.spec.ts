import { expect, test } from "@playwright/test";
import { threadJumpWords } from "../../src/renderer/src/cards/threadWords";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import {
  THREAD_ACK_REPLY,
  THREAD_ACK_TEXT,
  THREAD_CARD_TITLE,
  THREAD_PROMPT_MARKER,
} from "./crewScripts";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { cardReply, shownCard, shownEntry } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * A card's thread keeps the captain's place (INF-3124, direction B). The
 * captain: "interacting with a thread on a card: currently, it auto scroll
 * down to the latest message update at the bottom. That disrupts my flow...
 * Optional: there is a UI floating component indicating there are new
 * messages." Through the real path - a crewmate on the mock provider whose
 * answer the journey holds - the captain rereads a long reply from its
 * start while the answer lands: the thread stays, the jump down counts the
 * new lines, and the keys reach it: Shift+Tab and Enter, then command search.
 * Data: a reply of 25 lines, the crewmate's acknowledgement, then its
 * revision line and answer. Completion: the list's own scroll position and
 * the jump down's words; it runs on the desktop lane.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({
    withMockProvider: true,
    userDataDir: scratchDir("infinitary-card-thread-place-"),
  });
});

test.afterAll(async () => {
  await launched.close();
});

test("a thread read above keeps its place as the answer lands, and its jump down works by keys", async () => {
  const { app, page, mockProvider } = launched;
  await waitForFirstmateIdle(page);
  const input = page.getByRole("textbox", { name: "Task prompt" });
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
  await expect(input).toHaveValue(`${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });

  // A reply longer than the thread, which the crewmate acknowledges and holds its answer on.
  const lines = Array.from({ length: 24 }, (_, i) => `${i + 1}. a line of the note to reread`);
  const reply = cardReply(page);
  await reply.field.click();
  await reply.field.fill([THREAD_ACK_REPLY, ...lines].join("\n"));
  await reply.send.click();
  const thread = shownEntry(page).locator("[data-card-thread]");
  await expect(thread.getByText(THREAD_ACK_TEXT)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => mockProvider?.heldThreadAnswers() ?? 0, { timeout: 30_000 }).toBe(1);
  const list = thread.locator("[data-thread-messages]");
  const jump = thread.locator("[data-thread-jump]");
  const fromFoot = () =>
    list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  await expect.poll(fromFoot).toBeLessThanOrEqual(24);
  await expect(jump).toHaveCount(0);

  // The captain scrolls back to the reply's start; the jump down shows its plain arrow.
  await list.hover();
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -2000);
      return list.evaluate((node) => node.scrollTop);
    })
    .toBe(0);
  await expect(jump).toHaveText(threadJumpWords(0));

  // The crewmate's revision line and answer land below; the list stays at the start.
  mockProvider?.releaseThreadAnswer();
  await expect(jump).toHaveText(threadJumpWords(2), { timeout: 30_000 });
  await expect(thread.locator('[data-thread-message="host"]')).toHaveCount(1);
  expect(await list.evaluate((node) => node.scrollTop)).toBe(0);

  // Shift+Tab from the reply field reaches the jump down, and Enter takes the thread to the new lines.
  await pressKey(reply.field, "Shift+Tab");
  await expect(jump).toBeFocused();
  await pressKey(jump, "Enter");
  await expect(thread.locator('[data-thread-message="host"]')).toBeInViewport();
  await expect(list).toBeFocused();

  // Read above again, command search's "Go to the thread's new messages" goes to the foot.
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(jump).toHaveText(threadJumpWords(0));
  await runFromSearch(app, page, "cards.thread-new");
  await expect.poll(fromFoot).toBeLessThanOrEqual(24);
  await expect(jump).toHaveCount(0);
});
