import { createServer, type Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";
import {
  firstmatePauseTitle,
  RECHECK_ALLOWANCE_LABEL,
} from "../../src/core/orchestrator/cardService";
import {
  ALLOWANCE_CHECKING_WORDS,
  allowanceSpentWords,
  keptMessageWords,
  seatMovedLine,
  seatPausedLine,
  signedOutSentence,
} from "../../src/core/orchestrator/seat";
import { SEAT_MOVED_OPENING } from "../../src/core/orchestrator/wakes";
import { catalogEntry } from "../../src/shared/providers";
import { scratchDir } from "../helpers/scratchDirs";
import {
  CLAUDE_SEAT_LABEL,
  CLAUDE_SEAT_MODEL,
  claudeSeatRequests,
  launchClaudeSeat,
  otherSeatRequests,
  say,
} from "./claudeSeat";
import { cardBody } from "./frames";
import { bubbleWords, mateBubble, yourBubble } from "./lastTurn";
import type { LaunchedApp } from "./launch";
import { claudeIdentityHome, rewrittenClaudeHome, writeClaudeIdentity } from "./mockClaudeClient";

import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TITLE,
  type MockProviderServer,
  startMockProvider,
} from "./mockProvider";
import { failureLines, feedLine } from "./rails";
import { closeOpenCards, shownCard } from "./stack";
import { starterFor } from "./starters";
import { pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * The Firstmate's Claude seat cut off (W1 S12; the cut-off contract,
 * docs/architecture.md §16 "A paused seat"). The real client meets each
 * refusal the vendor can answer with - a 401, a 429 on a spent plan with
 * its reset, a 403 organisation refusal - and types it; the seat pauses on
 * the class's own card, in product words, and keeps the captain's words on
 * its durable inbox rather than trying them into the wall again. Each
 * class's way back is the one fact that clears it: the captain's "Try
 * Claude again", a new sign-in on this Mac. A paused seat is still the
 * app's seat: the first-launch gate stays down and the captain can type.
 * With Codex connected and allowance left there, the card asks to move
 * Firstmate there instead, and a Codex seat that runs out is offered
 * Claude; nothing moves unless the captain clicks, and the first turn on
 * the new seat is told it moved.
 */

/** Every card on the stack, shown or waiting behind the one that is. */
function cardTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.infinitary.cards.list()).map((card) => card.title),
  );
}

/**
 * The Firstmate requests the Claude client made that asked the model about
 * `words`: its latest user message carries them, not a tool's result.
 */
function tried(mockProvider: MockProviderServer, words: string): number {
  return claudeSeatRequests(mockProvider).filter((body) => {
    const tail = body.slice(body.lastIndexOf('"role":"user"'));
    return tail.includes(words) && !tail.includes('"tool_use_id"');
  }).length;
}

/** The open card titled `title`, as the core's stack holds it. */
async function pauseCard(page: Page, title: string) {
  return page.evaluate(
    async (wanted) => (await window.infinitary.cards.list()).find((card) => card.title === wanted),
    title,
  );
}

/** A quota refresh: the moment a paused seat reads its way back. */
async function refreshQuota(page: Page): Promise<void> {
  await page.evaluate(() => window.infinitary.quota.refresh());
}

/**
 * A paused seat is still the app's seat: after a quota push re-reads the
 * first-launch gate, the gate stays down and the captain can still type.
 */
async function stillOpen(page: Page): Promise<void> {
  await refreshQuota(page);
  expect((await page.evaluate(() => window.infinitary.app.firstRun())).gateOpen).toBe(false);
  await expect(page.getByRole("textbox", { name: "Task prompt" })).toBeEnabled();
  await expect(page.locator("[data-first-run-gate]")).toHaveCount(0);
}

/**
 * The feed line the seat writes once it runs on the model Firstmate is set
 * to now, named the way the app names its provider.
 */
async function movedLine(page: Page): Promise<string> {
  const model = await page.evaluate(() => window.infinitary.settings.getFirstmateModel());
  if (!model) throw new Error("Firstmate has no model.");
  return seatMovedLine({
    provider: catalogEntry(model.provider)?.name ?? model.provider,
    model: model.id,
  });
}

/** A line that starts with `words`: the part of it the spec can compose. */
function startingWith(words: string): RegExp {
  return new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/** The Firstmate requests any other seat made (a Pi seat's) whose latest user message carries `words`. */
function triedElsewhere(mockProvider: MockProviderServer, words: string): number {
  return otherSeatRequests(mockProvider).filter((body) =>
    body.slice(body.lastIndexOf('"role":"user"')).includes(words),
  ).length;
}

let launched: LaunchedApp | undefined;
let mockProvider: MockProviderServer | undefined;
let usageServer: Server | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await mockProvider?.close();
  mockProvider = undefined;
  if (usageServer?.listening) {
    await new Promise<void>((resolve, reject) =>
      usageServer?.close((error) => (error ? reject(error) : resolve())),
    );
  }
  usageServer = undefined;
});

test("a refusal pauses the seat on its own card, and Try Claude again answers the kept words", async () => {
  const mock = await startMockProvider();
  mockProvider = mock;
  launched = await launchClaudeSeat({ mockProvider: mock });
  const { page } = launched;
  mock.cutClaudeSeat({ class: "refused" });
  const words = `check the moorings ${ANSWER_PROMPT_MARKER}`;
  await say(page, words);

  const title = firstmatePauseTitle("refused", "Claude");
  await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
  const body = cardBody(page, title);
  await expect(feedLine(page, seatPausedLine("refused", `${title}.`, "Claude"))).toBeVisible();
  // Signing in again does not clear a refusal, so the card never says it does.
  await expect(body.getByText(/sign in/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try Claude again" })).toBeVisible();
  // A designed path, not a problem: no failure line beside the pause.
  await expect(failureLines(page)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("claude-seat-refused.png") });

  // Paused: the words were tried once and are not tried into the wall again,
  // and the seat is still the app's: the gate stays down.
  expect(tried(mock, words)).toBe(1);
  await stillOpen(page);
  expect(tried(mock, words)).toBe(1);
  // Picking Claude again is refused in the refusal's own words.
  const refusal = await page.evaluate(
    (model) =>
      window.infinitary.settings
        .setFirstmateModel(model)
        .then(() => null)
        .catch((error: Error) => error.message),
    CLAUDE_SEAT_MODEL,
  );
  expect(refusal).toContain("Claude is not answering your first mate right now.");

  // Claude answers again, and the captain says so: the kept words go through.
  mock.cutClaudeSeat(null);
  await page.getByRole("button", { name: "Try Claude again" }).click();
  await expect.poll(() => cardTitles(page), { timeout: 45_000 }).toContain(MOCK_ANSWER_TITLE);
  expect(tried(mock, words)).toBe(2);
  expect(await cardTitles(page)).not.toContain(title);
});

test("a message the paused seat keeps after its card is put away says it is saved, where the captain typed it", async () => {
  const mock = await startMockProvider();
  mockProvider = mock;
  launched = await launchClaudeSeat({ mockProvider: mock });
  const { page } = launched;
  mock.cutClaudeSeat({ class: "refused" });
  await say(page, `check the moorings ${ANSWER_PROMPT_MARKER}`);
  const title = firstmatePauseTitle("refused", "Claude");
  await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });

  // INF-1879: the captain puts the pause card aside, then writes again.
  // The saved card stays open but off stage; no words are tried into the
  // paused seat, and the captain's new message is not met with silence.
  await closeOpenCards(page);
  const later = "are you there?";
  await say(page, later);
  const saved = keptMessageWords(`${title}.`, "refused", "Claude");
  // The reply beside his message says it the moment he sends; the feed keeps it.
  await expect(bubbleWords(yourBubble(page))).toHaveText(later);
  await expect(bubbleWords(mateBubble(page))).toHaveText(saved, { timeout: 30_000 });
  await expect(feedLine(page, saved)).toBeVisible();
  expect(await pauseCard(page, title)).toMatchObject({ status: "ready", minimized: true });
  await expect(shownCard(page, title)).toBeHidden();
  expect(tried(mock, later)).toBe(0);
  await page.screenshot({ path: test.info().outputPath("claude-seat-kept-after-close.png") });
});

test("a lost sign-in pauses the seat, and signing in again on this Mac answers the kept words", async () => {
  const mock = await startMockProvider();
  mockProvider = mock;
  const homeDir = scratchDir("infinitary-home-");
  launched = await launchClaudeSeat({ mockProvider: mock, homeDir });
  const { page, userDataDir } = launched;
  mock.cutClaudeSeat({ class: "signed_out" });
  const words = `count the fenders ${ANSWER_PROMPT_MARKER}`;
  await say(page, words);

  const title = firstmatePauseTitle("signed_out", "Claude");
  await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
  await expect(
    feedLine(page, seatPausedLine("signed_out", signedOutSentence(CLAUDE_SEAT_LABEL), "Claude")),
  ).toBeVisible();
  // A designed path, not a problem: no failure line beside the pause.
  await expect(failureLines(page)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("claude-seat-signed-out.png") });
  expect(tried(mock, words)).toBe(1);
  await stillOpen(page);
  expect(tried(mock, words)).toBe(1);
  await launched.close();
  launched = undefined;

  // The person signs in to Claude again on this Mac while the app is closed:
  // the store's credential is written anew. The next start reads it, and
  // the kept words go through on Claude.
  mock.cutClaudeSeat(null);
  launched = await launchClaudeSeat({
    mockProvider: mock,
    userDataDir,
    homeDir,
    // The machine's login keeps its credential in the plain-file store, so
    // a new sign-in is a rewrite of it.
    prepareHome: rewrittenClaudeHome,
  });
  await expect
    .poll(() => cardTitles(launched?.page as Page), { timeout: 45_000 })
    .toContain(MOCK_ANSWER_TITLE);
  expect(tried(mock, words)).toBe(2);
  expect(await cardTitles(launched.page)).not.toContain(title);
});

test("a spent allowance pauses with its reset, asks to move to Codex, and tries nothing more", async () => {
  const mock = await startMockProvider();
  mockProvider = mock;
  launched = await launchClaudeSeat({ mockProvider: mock, withCodex: true });
  const { page } = launched;
  mock.cutClaudeSeat({ class: "no_headroom", resetsAt: Date.now() + 2 * 3600_000 });
  const words = `plot the tide ${ANSWER_PROMPT_MARKER}`;
  await say(page, words);

  // Rung 2: Codex has allowance left, so the one card asks to move there.
  const title = firstmatePauseTitle("no_headroom", "Claude");
  await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Move to Codex" })).toBeVisible();
  // The reset the line ends with is the allowance reading's own.
  const spent = seatPausedLine("no_headroom", allowanceSpentWords(CLAUDE_SEAT_LABEL), "Claude");
  await expect(feedLine(page, startingWith(spent))).toBeVisible();
  // A designed path, not a problem: no failure line beside the pause.
  await expect(failureLines(page)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("claude-seat-no-headroom-move.png") });

  // Nothing moves before a click, and nothing is tried before the reset.
  expect(tried(mock, words)).toBe(1);
  await stillOpen(page);
  expect(tried(mock, words)).toBe(1);
  expect(await page.evaluate(() => window.infinitary.settings.getFirstmateModel())).toMatchObject({
    provider: "anthropic-claude",
  });
  expect(triedElsewhere(mock, words)).toBe(0);

  // The captain moves it: the Codex seat answers the kept words, and its
  // first turn is told it moved and why (the owner's Q4 b).
  await page.getByRole("button", { name: "Move to Codex" }).click();
  await expect.poll(() => triedElsewhere(mock, words), { timeout: 45_000 }).toBeGreaterThan(0);
  await expect.poll(() => cardTitles(page), { timeout: 45_000 }).toContain(MOCK_ANSWER_TITLE);
  expect(otherSeatRequests(mock)[0]).toContain(SEAT_MOVED_OPENING);
  expect(await page.evaluate(() => window.infinitary.settings.getFirstmateModel())).toMatchObject({
    provider: "openai-codex",
  });
  await expect(feedLine(page, await movedLine(page))).toBeVisible();
  expect(tried(mock, words)).toBe(1);
});

// INF-1079, the captain: "it would be great to have a button here to trigger
// a recheck" after switching Claude accounts elsewhere.
// INF-2318: the captain replaced the independent focus scan with the next shared store read.
// This journey must use the real allowance path, not a finished-snapshot fixture.
test("a spent allowance's Recheck allowance, by key, keeps the card on one login, and a reading after a switch answers the kept words once", async () => {
  const mock = await startMockProvider();
  mockProvider = mock;
  const homeDir = scratchDir("infinitary-home-");
  let remaining = 80;
  const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
  usageServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ five_hour: { utilization: 100 - remaining, resets_at: resetsAt } }),
    );
  });
  await new Promise<void>((resolve) => usageServer?.listen(0, "127.0.0.1", resolve));
  const address = usageServer.address();
  if (!address || typeof address === "string")
    throw new Error("The usage stand-in has no address.");
  launched = await launchClaudeSeat({
    mockProvider: mock,
    homeDir,
    prepareHome: claudeIdentityHome("account-a", "kun@example.com"),
    env: {
      INFINITARY_QUOTA_FIXTURE_DIR: "",
      INFINITARY_CLAUDE_USAGE_URL: `http://127.0.0.1:${address.port}/usage`,
    },
  });
  remaining = 0;
  const { app, page } = launched;
  mock.cutClaudeSeat({ class: "no_headroom", resetsAt: Date.now() + 2 * 3600_000 });
  const words = `chart the shoals ${ANSWER_PROMPT_MARKER}`;
  await say(page, words);
  const title = firstmatePauseTitle("no_headroom", "Claude");
  await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
  const recheck = shownCard(page, title).getByRole("button", { name: RECHECK_ALLOWANCE_LABEL });
  await expect(recheck).toBeVisible();

  await test.step("the same login: ⌘1 rechecks, and the card comes back with Recheck allowance", async () => {
    const before = await pauseCard(page, title);
    await pressWindowKey(app, "1", ["meta"]);
    // Closed by the click, the card comes back as a new one once the reading is in.
    await expect
      .poll(
        async () => {
          const after = await pauseCard(page, title);
          return (
            after !== undefined &&
            after.lifecycleId !== before?.lifecycleId &&
            after.actions.some((action) => action.label === RECHECK_ALLOWANCE_LABEL) &&
            !after.body.includes(ALLOWANCE_CHECKING_WORDS)
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(recheck).toBeVisible();
    expect(tried(mock, words)).toBe(1);
  });

  await test.step("another login: the next reading hears it and answers the kept words", async () => {
    // The captain switched Claude to an account with room outside the app,
    // then asks for its allowance through the same key as before.
    writeClaudeIdentity(homeDir, "account-b", "kun@example.com");
    remaining = 80;
    mock.cutClaudeSeat(null);
    await pressWindowKey(app, "1", ["meta"]);
    await expect.poll(() => cardTitles(page), { timeout: 45_000 }).toContain(MOCK_ANSWER_TITLE);
    expect(await cardTitles(page)).not.toContain(title);
    expect(tried(mock, words)).toBe(2);
  });

  await test.step("Recheck allowance from command search delivers nothing twice", async () => {
    await runFromSearch(app, page, "allowance.recheck");
    await refreshQuota(page);
    expect(tried(mock, words)).toBe(2);
    expect(await cardTitles(page)).not.toContain(title);
  });
});

test("a Codex seat that runs out is offered Claude, moves only on the click, and Claude answers", async () => {
  const mock = await startMockProvider();
  mockProvider = mock;
  launched = await launchClaudeSeat({ mockProvider: mock, withCodex: true, codexPercent: 0 });
  const { page } = launched;
  // The captain put the Firstmate on Codex's high model.
  await page.evaluate(
    (id) => window.infinitary.settings.setFirstmateModel({ provider: "openai-codex", id }),
    starterFor("openai-codex", "high"),
  );
  const words = `sound the channel ${ANSWER_PROMPT_MARKER}`;
  await say(page, words);

  // Rung 2 (the owner's Q6 a): Claude has room, so the card asks to move there.
  const title = firstmatePauseTitle("no_headroom", "Codex");
  await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Move to Claude" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("codex-seat-move-to-claude.png") });

  // Nothing moves before the click, and nothing is tried on either seat.
  await stillOpen(page);
  expect(await page.evaluate(() => window.infinitary.settings.getFirstmateModel())).toMatchObject({
    provider: "openai-codex",
  });
  expect(tried(mock, words)).toBe(0);
  expect(triedElsewhere(mock, words)).toBe(0);

  await page.getByRole("button", { name: "Move to Claude" }).click();
  await expect.poll(() => tried(mock, words), { timeout: 45_000 }).toBe(1);
  await expect.poll(() => cardTitles(page), { timeout: 45_000 }).toContain(MOCK_ANSWER_TITLE);
  expect(claudeSeatRequests(mock)[0]).toContain(SEAT_MOVED_OPENING);
  expect(await page.evaluate(() => window.infinitary.settings.getFirstmateModel())).toMatchObject({
    provider: "anthropic-claude",
  });
  await expect(feedLine(page, await movedLine(page))).toBeVisible();
  expect(triedElsewhere(mock, words)).toBe(0);
});
