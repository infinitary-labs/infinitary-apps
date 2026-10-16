import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cardMetaWords, FIRSTMATE_CARD_META } from "../../src/shared/cards";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TEXT,
  MOCK_ANSWER_TITLE,
  MOCK_FM_CHAT_TEXT,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { activityFrame, feedLineOf } from "./rails";
import { cardMeta, shownCard } from "./stack";

/**
 * The orchestrator loop, phase A acceptance (the loop inversion): every
 * user turn goes to the Firstmate agent, which answers itself - chit-chat
 * costs no worktree, no crewmate, no card; an answer arrives as a card only
 * because the user asked for something. The rolling session survives a
 * restart. The auth file stays 0600 and ~/.pi stays untouched.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
  // Pre-seed a group-readable auth file: the auth service must clamp it.
  writeFileSync(join(launched.userDataDir, "auth", "auth.json"), "{}\n", { mode: 0o644 });
});

test.afterAll(async () => {
  await launched.close();
});

/** The captain's words in this file's turns, as the feed echoes them back. */
const GREETING = "hello there";
const BEFORE_RESTART = "hello before the restart";
const AFTER_RESTART = "hello again";

function worktreeCount(userDataDir: string): number {
  const dir = join(userDataDir, "worktrees");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

test("chit-chat is answered by Firstmate with zero cards and zero crewmates", async () => {
  const { page, userDataDir, mockProvider } = launched;
  await askFirstmate(page, GREETING);

  // Chit-chat is not a card and not a scraped feed line; the screen stays
  // in the null state. The host echoes the user turn; Firstmate text does not.
  await expect(feedLineOf(page, { type: "user_turn", text: GREETING })).toBeVisible({
    timeout: 10_000,
  });
  expect(mockProvider?.requests() ?? 0).toBeGreaterThan(0);
  await expect(page.getByText(MOCK_FM_CHAT_TEXT)).toHaveCount(0);
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Null state",
  );

  // No worktree, no crewmate session, no task was created for a greeting.
  expect(worktreeCount(userDataDir)).toBe(0);
  expect(existsSync(join(userDataDir, "crewmates"))).toBe(false);
});

test("a question yields one answer card from Firstmate", async () => {
  const { page, userDataDir } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`please ${ANSWER_PROMPT_MARKER}: how is quota?`);
  await input.press("Enter");

  await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({ timeout: 30_000 });
  await expect(cardBody(page, MOCK_ANSWER_TITLE).getByText(MOCK_ANSWER_TEXT)).toBeVisible();
  // The answer card is Firstmate's own, not a crewmate's.
  await expect(cardMeta(page, MOCK_ANSWER_TITLE)).toHaveText(cardMetaWords(FIRSTMATE_CARD_META));
  expect(worktreeCount(userDataDir)).toBe(0);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  // The stack empties.
  await expect(page.locator("[data-card-layer]")).toHaveCount(0, { timeout: 10_000 });
});

test("the app-scoped auth file is clamped to 0600", async () => {
  const mode = statSync(join(launched.userDataDir, "auth", "auth.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("the pi user config under HOME stays untouched", async () => {
  expect(existsSync(join(launched.homeDir, ".pi"))).toBe(false);
});

test("the rolling session resumes across a restart (Q4)", async () => {
  // A turn of its own for the thread to carry across the restart.
  await askFirstmate(launched.page, BEFORE_RESTART);
  // Quit and relaunch against the same userData; a fresh mock provider is
  // fine because launchApp rewrites the app-scoped models.json.
  const { userDataDir } = launched;
  await launched.close();
  launched = await launchApp({ withMockProvider: true, userDataDir });

  await askFirstmate(launched.page, AFTER_RESTART);
  // User-turn receipts persist across restart (P10); Firstmate close-out
  // text is not a feed line before or after.
  await expect(feedLineOf(launched.page, { type: "user_turn", text: AFTER_RESTART })).toBeVisible({
    timeout: 10_000,
  });
  expect(launched.mockProvider?.requests() ?? 0).toBeGreaterThan(0);
  await expect(
    feedLineOf(launched.page, { type: "user_turn", text: BEFORE_RESTART }),
  ).toBeVisible();
  await expect(launched.page.getByText(MOCK_FM_CHAT_TEXT)).toHaveCount(0);
  await expect(activityFrame(launched.page).getByText(MOCK_FM_CHAT_TEXT)).toHaveCount(0);
  // Still exactly one rolling session file: the thread was resumed, not
  // restarted.
  const sessions = readdirSync(join(userDataDir, "firstmate", "sessions"));
  expect(sessions.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
});
