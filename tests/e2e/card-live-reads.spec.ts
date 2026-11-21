import { expect, type Page, test } from "@playwright/test";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  cardLiveReads,
  LIVE_READS_CARD_TITLE,
  LIVE_READS_END_MARKER,
  LIVE_READS_PROMPT_MARKER,
} from "./scenarios/cardLiveReads";
import { cardReply, expectCardSeen, expectEndedCard, showCard } from "./stack";

/**
 * A crewmate's card reads live app data through the panels' own interface
 * (INF-5531 piece 1; docs/ui-plugins.md "A card's reads"). The captain's
 * words: "we should not invent a new interface, but through the same
 * interface first mate, settings and custom panels already all use", and
 * their answer on closed cards: "Only while the card is open. Past cards
 * keep what the author wrote, but a closed card stops updating."
 *
 * Promised result: the card's own script draws the record's task count
 * through the `sql` read and redraws when a task is added; a read it did
 * not declare is refused; once its author ends it, it stops updating and
 * keeps what it drew. Data: the app's own record, its tasks made by
 * commissioning crewmates through the stand-in. Completion signals: the
 * lines the card's script fills, and the task board's own count. Platform
 * prerequisites: none beyond the hermetic launch. Shared resources: none.
 */

let launched: LaunchedApp;

/** The lines the live card's script fills, read from its frame. */
async function liveLines(page: Page) {
  const body = cardBody(page, LIVE_READS_CARD_TITLE);
  const line = (name: string) => body.locator(`[data-${name}]`).textContent();
  return {
    count: Number(await line("count")),
    updates: Number(await line("updates")),
    board: await line("board"),
    undeclared: await line("undeclared"),
    stopped: await line("stopped"),
  };
}

/** How many tasks the window's task board holds. */
async function boardTasks(page: Page): Promise<number> {
  return (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length;
}

async function commission(page: Page, title: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
}

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [cardLiveReads] });
});

test.afterAll(async () => {
  await launched.close();
});

test("a crewmate's card reads the record live while it is open, and stops once it is ended", async () => {
  const { page } = launched;

  await test.step("the card draws the record's task count and refuses a read it did not declare", async () => {
    await commission(page, LIVE_READS_PROMPT_MARKER);
    await expect(() => showCard(page, LIVE_READS_CARD_TITLE)).toPass({ timeout: 45_000 });
    // At least its own crewmate's task is on the record.
    await expect.poll(async () => (await liveLines(page)).count).toBeGreaterThan(0);
    await expect
      .poll(async () => liveLines(page))
      .toMatchObject({ board: "live", undeclared: "read_not_declared", stopped: "open" });
  });

  await test.step("a new task redraws the count", async () => {
    const before = await liveLines(page);
    const board = await boardTasks(page);
    await commission(page, "count me too");
    await expect.poll(() => boardTasks(page), { timeout: 30_000 }).toBe(board + 1);
    await showCard(page, LIVE_READS_CARD_TITLE);
    await expect.poll(async () => (await liveLines(page)).count).toBe(before.count + 1);
    expect((await liveLines(page)).updates).toBeGreaterThan(before.updates);
  });

  await test.step("ended by its crewmate, it stops updating and keeps what it drew", async () => {
    await showCard(page, LIVE_READS_CARD_TITLE);
    await expectCardSeen(page, LIVE_READS_CARD_TITLE);
    await cardReply(page).field.fill(LIVE_READS_END_MARKER);
    await cardReply(page).send.click();
    await expectEndedCard(page, LIVE_READS_CARD_TITLE, { timeout: 30_000 });
    // The window ended the count's subscription when the card ended: the
    // script heard why, and the count it drew stays.
    await expect.poll(async () => (await liveLines(page)).stopped).toBe("read_not_declared");
    const kept = await liveLines(page);
    const board = await boardTasks(page);
    await commission(page, "one more after it ended");
    // The board's push and the count's read ride the same app events, so
    // once the board holds the new task a live count would have moved too.
    await expect.poll(() => boardTasks(page), { timeout: 30_000 }).toBe(board + 1);
    await showCard(page, LIVE_READS_CARD_TITLE);
    expect(await liveLines(page)).toEqual(kept);
  });
});
