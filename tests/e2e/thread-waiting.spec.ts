import { expect, type Page, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { launchClaudeCrew, signedInAs } from "./claudeCrew";
import {
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_HELD_CARD_MARKER,
  CLAUDE_HELD_REPLY,
  CLAUDE_REFUSED_PROMPT_MARKER,
  MOCK_CLAUDE_HELD_ANSWER,
  MOCK_CLAUDE_HELD_CARD_TITLE,
} from "./crewScripts";
import type { LaunchedApp } from "./launch";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { cardReply, showCard } from "./stack";

/**
 * The thread's waiting line (FI3-592; docs/card-threads.md, "The waiting
 * line"). The captain replies under a Claude crewmate's card, and the
 * reply meets Claude refusing the sign-in: the app keeps it on the lane,
 * attempts nothing more, and the thread says so - saved, what holds it and
 * who goes next - instead of going quiet. The line is read from the task's
 * state, so a restart on the same login shows it again; once another login
 * serves, the kept reply goes out, the crewmate answers in the thread, and
 * the line is gone.
 *
 * The login changes between launches, because that is where the app reads
 * it for sure (tests/e2e/claude-crew-cutoff.spec.ts).
 */

const TITLE = `chart the reef ${CLAUDE_CREW_PROMPT_MARKER} ${CLAUDE_REFUSED_PROMPT_MARKER} ${CLAUDE_HELD_CARD_MARKER}`;

/** The thread column beside the shown card. */
function thread(page: Page) {
  return page.locator("[data-card-thread]");
}

/** The waiting line a held account writes, by its typed wait and class. */
function heldLine(page: Page) {
  return thread(page).locator('[data-thread-waiting="account"][data-thread-hold="refused"]');
}

test("a reply kept behind a refused sign-in says so in its thread, across a restart, until the crewmate answers", async () => {
  // Three launches of one app: each keeps the minute it would have as a
  // test of its own.
  test.setTimeout(3 * 60_000);
  const homeDir = scratchDir("infinitary-home-");
  const mockProvider: MockProviderServer = await startMockProvider();
  const taskPrompt = (page: Page) => page.getByRole("textbox", { name: "Task prompt" });
  let launched: LaunchedApp | undefined;
  try {
    // 1. The crewmate puts up its card while Claude still serves it.
    mockProvider.refuseClaude(false);
    launched = await launchClaudeCrew({
      homeDir,
      reuseMockProvider: mockProvider,
      prepareHome: signedInAs("account-one"),
    });
    const userDataDir = launched.userDataDir;
    const input = taskPrompt(launched.page);
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.click();
    await input.fill(`commission a crewmate: ${TITLE}`);
    await input.press("Enter");
    await expect
      .poll(
        () =>
          launched?.page.evaluate(
            async (title) =>
              (await window.infinitary.cards.list()).some((c) => c.title === title && !c.awaiting),
            MOCK_CLAUDE_HELD_CARD_TITLE,
          ),
        { timeout: 45_000 },
      )
      .toBe(true);
    await showCard(launched.page, MOCK_CLAUDE_HELD_CARD_TITLE);

    // 2. Claude starts refusing the sign-in, and the captain's reply meets it:
    // kept, with nothing working on it, and the thread names the hold.
    mockProvider.refuseClaude(true);
    const reply = cardReply(launched.page).field;
    await reply.click();
    await reply.fill(CLAUDE_HELD_REPLY);
    await cardReply(launched.page).send.click();
    await expect(heldLine(launched.page)).toBeVisible({ timeout: 45_000 });
    await expect(thread(launched.page).locator("[data-thread-working]")).toHaveCount(0);
    await thread(launched.page).screenshot({
      path: test.info().outputPath("thread-waiting-held.png"),
    });
    await launched.close();
    launched = undefined;

    // 3. A restart on the same login: the hold and the reply's wait are on
    // the record, so the thread says the same thing again.
    launched = await launchClaudeCrew({
      userDataDir,
      homeDir,
      reuseMockProvider: mockProvider,
      prepareHome: signedInAs("account-one"),
    });
    await expect(taskPrompt(launched.page)).toBeEnabled({ timeout: 30_000 });
    await showCard(launched.page, MOCK_CLAUDE_HELD_CARD_TITLE);
    await expect(heldLine(launched.page)).toBeVisible({ timeout: 30_000 });
    await thread(launched.page).screenshot({
      path: test.info().outputPath("thread-waiting-restart.png"),
    });
    await launched.close();
    launched = undefined;

    // 4. Another login, which Claude serves: the kept reply goes out, the
    // crewmate answers in the thread, and the waiting line is gone.
    mockProvider.refuseClaude(false);
    launched = await launchClaudeCrew({
      userDataDir,
      homeDir,
      reuseMockProvider: mockProvider,
      prepareHome: signedInAs("account-two"),
    });
    await expect(taskPrompt(launched.page)).toBeEnabled({ timeout: 30_000 });
    await showCard(launched.page, MOCK_CLAUDE_HELD_CARD_TITLE);
    await expect(
      thread(launched.page)
        .locator('[data-thread-message="crewmate"]')
        .filter({ hasText: MOCK_CLAUDE_HELD_ANSWER }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(thread(launched.page).locator("[data-thread-waiting]")).toHaveCount(0);
    await thread(launched.page).screenshot({
      path: test.info().outputPath("thread-waiting-answered.png"),
    });
  } finally {
    await launched?.close();
    await mockProvider.close();
  }
});
