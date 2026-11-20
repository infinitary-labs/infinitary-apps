import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { firstmatePauseTitle } from "../../src/core/orchestrator/hostCards";
import * as m from "../../src/shared/i18n/messages.generated";
import { SAVED_RESETS_PAGE } from "../../src/shared/quota";
import { scratchDir } from "../helpers/scratchDirs";
import { CLAUDE_SEAT_ACCOUNT, CODEX_SEAT_ACCOUNT, launchClaudeSeat, say } from "./claudeSeat";
import { cardBody } from "./frames";
import type { LaunchedApp } from "./launch";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { promptInput } from "./prompt";
import { seedQuotaFixture } from "./quotaFixtures";
import { shownCard } from "./stack";
import { starterFor } from "./starters";
import { focusOn, pressKey } from "./windowKeys";

/**
 * Saved resets (INF-5369 piece 6, docs/quota.md "Saved resets"): the first
 * mate runs on Codex, whose allowance is spent while ChatGPT says the account
 * holds a saved reset that would refill it now. The spent-allowance card says
 * so, Enter on its link opens ChatGPT's usage page, where the captain uses
 * the reset, and the account's Subscriptions row says the count. Infinitary
 * uses none itself. The system browser is a recorder here.
 */

/** The live Codex reading's saved resets (`tests/fixtures/quota-credits`), here applying now. */
const LIVE = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/quota-credits/codex-usage-credits.json"), "utf8"),
) as { rate_limit_reset_credits: { available_count: number } };
const HELD = LIVE.rate_limit_reset_credits.available_count;

/** Both seats' allowance readings: Claude and Codex spent, Codex holding a saved reset that applies now. */
function spentReadings(now: number): string {
  const HOUR = 3600 * 1000;
  const row = (provider: string, label: string, accountId: string) => ({
    provider,
    label,
    accountId,
    accountLabel: "sailor@example.com",
    status: "ok" as const,
    stale: false,
    windows: [
      {
        id: "five_hour",
        label: "session",
        percentRemaining: 0,
        pace: "behind" as const,
        resetText: "resets 6pm",
        resetsAtMs: now + 2 * HOUR,
        windowSeconds: 18_000,
      },
    ],
  });
  return seedQuotaFixture(scratchDir("infinitary-saved-reset-quota-"), {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      row("claude", "Claude", CLAUDE_SEAT_ACCOUNT),
      {
        ...row("codex", "Codex", CODEX_SEAT_ACCOUNT),
        savedResets: { available: HELD, applicable: HELD },
      },
    ],
  });
}

/** Replaces the system browser with a recorder of the addresses it is asked to open. */
const recordOpens = (launched: LaunchedApp) =>
  launched.app.evaluate(({ shell }) => {
    const recorded: string[] = [];
    (globalThis as { __fmOpened?: string[] }).__fmOpened = recorded;
    shell.openExternal = async (url: string) => {
      recorded.push(url);
    };
  });

const opened = (launched: LaunchedApp) =>
  launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);

test("a spent Codex seat's card says its saved reset and opens ChatGPT's usage page by key, and its row says the count", async () => {
  test.setTimeout(3 * 60_000);
  let mock: MockProviderServer | undefined;
  let launched: LaunchedApp | undefined;
  try {
    mock = await startMockProvider();
    launched = await launchClaudeSeat({
      mockProvider: mock,
      withCodex: true,
      env: { INFINITARY_QUOTA_FIXTURE_DIR: spentReadings(Date.now()) },
    });
    const { page } = launched;
    await recordOpens(launched);
    const codex = (await page.evaluate(() => window.infinitary.accounts.list())).find(
      (account) => account.id === CODEX_SEAT_ACCOUNT,
    );
    // The captain put the first mate on Codex's high model.
    await page.evaluate(
      (id) => window.infinitary.settings.setFirstmateModel({ provider: "openai-codex", id }),
      starterFor("openai-codex", "high"),
    );
    await say(page, "sound the channel");

    const title = firstmatePauseTitle("no_headroom", "Codex");
    await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
    const body = cardBody(page, title);
    await expect(
      body.getByText(m.cardSavedResetsNow({ account: `Codex · ${codex?.label}`, count: HELD })),
    ).toBeVisible();

    // Enter on the link opens the provider's usage page; nothing else is opened or used.
    const link = body.getByRole("link", {
      name: m.cardSavedResetsOpenPage({ site: new URL(SAVED_RESETS_PAGE.codex as string).host }),
    });
    await focusOn(promptInput(page));
    await pressKey(link, "Enter");
    await expect.poll(() => opened(launched as LaunchedApp)).toEqual([SAVED_RESETS_PAGE.codex]);

    // The account's row in Settings → Intelligence says the count and where one is used.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    await expect(
      page.locator(`[data-account-row="${CODEX_SEAT_ACCOUNT}"] [data-saved-resets]`),
    ).toHaveText(m.settingsSubscriptionsSavedResets({ count: HELD, site: "chatgpt.com" }));
  } finally {
    await launched?.close();
    await mock?.close();
  }
});
