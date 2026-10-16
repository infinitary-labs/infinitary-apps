import { test as base, expect, type Page } from "@playwright/test";
import {
  CLAUDE_SEAT_ACCOUNT,
  CLAUDE_SEAT_MODEL,
  claudeQueued,
  claudeSeatRequests,
  launchClaudeSeat,
  otherSeatRequests,
  say,
} from "./claudeSeat";
import type { LaunchedApp } from "./launch";
import { MOCK_CLAUDE_OAUTH_TOKEN } from "./mockClaudeClient";
import {
  ANSWER_PROMPT_MARKER,
  CLAUDE_CREW_PROMPT_MARKER,
  FM_SEAT_HOLD_MARKER,
  FM_SEAT_STEER_WORD,
  FM_SEAT_STEERED_TITLE,
  MOCK_ANSWER_TITLE,
  MOCK_CLAUDE_CARD_TITLE,
  type MockProviderServer,
  startMockProvider,
} from "./mockProvider";
import { shownCard } from "./stack";

/**
 * The Firstmate on Claude (W1 S12): a person whose Firstmate the captain
 * put on the machine's Claude login talks to it like any other. The seat
 * runs the SDK's own client against the mock provider
 * (tests/e2e/claudeSeat.ts), so each turn crosses the real stream-json
 * protocol and the real in-process tool server: a card comes back through
 * `emit_card`, a crewmate through `spawn_crewmate`, and a steer typed while
 * the Firstmate works lands in its running turn. The Intelligence tab's
 * picker offers Claude beside every other subscription.
 */

/** Every card on the stack, shown or waiting behind the one that is. */
function cardTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.infinitary.cards.list()).map((card) => card.title),
  );
}

type ClaudeSeatApp = LaunchedApp & { mockProvider: MockProviderServer };

async function seatState(page: Page) {
  return page.evaluate(async () => ({
    cards: await window.infinitary.cards.list(),
    board: await window.infinitary.tasks.board(),
    account: await window.infinitary.settings.getFirstmateAccount(),
    model: await window.infinitary.settings.getFirstmateModel(),
  }));
}

// Every named case owns its app, HOME and provider history. Selecting one
// alone or starting a new worker never borrows a previous case's turns.
const test = base.extend<{ seat: ClaudeSeatApp }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
  seat: async ({}, use, testInfo) => {
    const mockProvider = await startMockProvider();
    let launched: LaunchedApp | undefined;
    try {
      launched = await launchClaudeSeat({ mockProvider });
      const fresh = await seatState(launched.page);
      expect(fresh.cards).toEqual([]);
      // Putting the Firstmate on Claude is the captain's own Intelligence
      // change, which leaves its closed operation record; a fresh seat has
      // no other task and nothing open.
      expect(
        fresh.board.tasks.filter((task) => task.kind !== "operation" || task.status !== "done"),
      ).toEqual([]);
      await testInfo.attach("fresh-claude-seat", {
        body: JSON.stringify(
          { homeDir: launched.homeDir, userDataDir: launched.userDataDir, ...fresh },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await use({ ...launched, mockProvider });
      await testInfo.attach("claude-seat-result", {
        body: JSON.stringify(await seatState(launched.page), null, 2),
        contentType: "application/json",
      });
    } finally {
      try {
        await launched?.close();
      } finally {
        await mockProvider.close();
      }
    }
  },
});

test("a captain turn is answered with a card, on Claude", async ({ seat }) => {
  const { page, mockProvider } = seat;
  await say(page, `why does the meter idle? ${ANSWER_PROMPT_MARKER}`);
  await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({
    timeout: 45_000,
  });
  await page.screenshot({ path: test.info().outputPath("claude-seat-card.png") });

  // Every Firstmate turn went through the Claude client, on the dummy
  // subscription token - never a Pi seat, never the machine's login.
  const served = claudeSeatRequests(mockProvider);
  expect(served.length).toBeGreaterThanOrEqual(1);
  expect(served.some((body) => body.includes(ANSWER_PROMPT_MARKER))).toBe(true);
  expect(otherSeatRequests(mockProvider)).toEqual([]);
  const headers = mockProvider
    .requestHeaders()
    .filter((entry) => entry["user-agent"]?.startsWith("claude-cli/"));
  for (const entry of headers) {
    expect(entry.authorization).toBe(`Bearer ${MOCK_CLAUDE_OAUTH_TOKEN}`);
  }
  // The seat is bound to the Claude login, on the model the captain picked.
  const bound = await page.evaluate(() => window.infinitary.settings.getFirstmateAccount());
  expect(bound).toBe(CLAUDE_SEAT_ACCOUNT);
  const model = await page.evaluate(() => window.infinitary.settings.getFirstmateModel());
  expect(model).toEqual(CLAUDE_SEAT_MODEL);
});

test("a crewmate is spawned through spawn_crewmate from the Claude seat", async ({ seat }) => {
  const { page, mockProvider } = seat;
  const title = `count the rivets ${CLAUDE_CREW_PROMPT_MARKER}`;
  await say(page, `commission a crewmate: ${title}`);
  // The crewmate's own card lands on the stack: the Firstmate's spawn
  // reached the crew.
  await expect.poll(() => cardTitles(page), { timeout: 45_000 }).toContain(MOCK_CLAUDE_CARD_TITLE);
  expect(
    claudeSeatRequests(mockProvider).some(
      (body) => body.includes("mcp__infinitary__spawn_crewmate") && body.includes('"tool_use_id"'),
    ),
  ).toBe(true);
});

test("a steer typed while the Firstmate works lands in its running turn", async ({ seat }) => {
  const { page, mockProvider, homeDir } = seat;
  await say(page, `how is everyone doing? ${FM_SEAT_HOLD_MARKER}`);
  // The turn looked at the crew, and its next step waits on the model.
  await expect.poll(() => mockProvider.heldFirstmate(), { timeout: 45_000 }).toBe(1);

  await say(page, FM_SEAT_STEER_WORD);
  // The client queued the steer into the running session.
  await expect
    .poll(() => claudeQueued(homeDir, FM_SEAT_STEER_WORD), { timeout: 30_000 })
    .toBe(true);
  mockProvider.releaseHeldFirstmate();

  await expect.poll(() => cardTitles(page), { timeout: 45_000 }).toContain(FM_SEAT_STEERED_TITLE);
  // It rode the running turn: the request that carried it also carried the
  // held step's tool result, and it was never sent again as a turn of its own.
  const carrying = claudeSeatRequests(mockProvider).filter((body) =>
    body.includes(FM_SEAT_STEER_WORD),
  );
  expect(carrying[0]).toContain('"tool_use_id"');
  expect(carrying[0]).toContain(FM_SEAT_HOLD_MARKER);
  await expect(shownCard(page, FM_SEAT_STEERED_TITLE)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("claude-seat-steer.png") });
  await test.info().attach("mid-turn-steer", {
    body: JSON.stringify({
      queuedInClient: claudeQueued(homeDir, FM_SEAT_STEER_WORD),
      sharesHeldToolResult: carrying[0]?.includes('"tool_use_id"'),
      sharesHeldTurn: carrying[0]?.includes(FM_SEAT_HOLD_MARKER),
    }),
    contentType: "application/json",
  });
});

test("the Intelligence tab's picker offers Claude for Firstmate, and picking it takes", async ({
  seat,
}) => {
  const { page } = seat;
  const firstmateModel = async () => {
    const model = await page.evaluate(() => window.infinitary.settings.getFirstmateModel());
    return model ? `${model.provider}/${model.id}` : null;
  };
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  const picker = page.locator('[data-setting="firstmate-model"]').getByRole("combobox");
  const claude = `${CLAUDE_SEAT_MODEL.provider}/${CLAUDE_SEAT_MODEL.id}`;
  await expect(picker).toHaveValue(claude, { timeout: 15_000 });
  // Let go of the pin, then pick Claude again from the list.
  await picker.selectOption("");
  await expect.poll(firstmateModel).not.toBe(claude);
  await picker.selectOption(claude);
  await expect.poll(firstmateModel).toBe(claude);
  await expect(picker).toHaveValue(claude);
});
