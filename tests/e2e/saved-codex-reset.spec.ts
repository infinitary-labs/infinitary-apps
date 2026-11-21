import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { firstmatePauseTitle } from "../../src/core/orchestrator/hostCards";
import * as m from "../../src/shared/i18n/messages.generated";
import { SAVED_RESETS_PAGE } from "../../src/shared/quota";
import { scratchDir } from "../helpers/scratchDirs";
import {
  CLAUDE_SEAT_ACCOUNT,
  CODEX_SEAT_ACCOUNT,
  CODEX_SEAT_CHATGPT_ID,
  launchClaudeSeat,
  say,
} from "./claudeSeat";
import { cardBody } from "./frames";
import { leaveSettings } from "./handoverCards";
import { answerDecisionsWithJev, type JevStandIn, startJevStandIn } from "./jevStandIn";
import type { LaunchedApp } from "./launch";
import { signInCodexHome, writeMockCodexClient } from "./mockCodexClient";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { promptInput } from "./prompt";
import { seedQuotaFixture } from "./quotaFixtures";
import { feedLineOf } from "./rails";
import { shownCard } from "./stack";
import { starterFor } from "./starters";
import { focusOn, pressKey } from "./windowKeys";

/**
 * Saved resets (INF-5369 piece 6, docs/quota.md "Saved resets"): the first
 * mate runs on Codex, whose allowance is spent while ChatGPT says the account
 * holds a saved reset that would refill it now. The spent-allowance card says
 * so, Enter on its link opens ChatGPT's usage page, where the captain uses
 * the reset, and the account's Subscriptions row says the count. The card's
 * Use a saved reset (INF-5478's plan, piece 1; docs/codex-client.md) uses one
 * through the Codex CLI, here a stand-in (`mockCodexClient.ts`), signing it
 * in on the account's row first, or at once when Codex already keeps the
 * account's sign-in. The system browser is a recorder here. With the
 * account's Use saved resets on their own turned on from its row by keys
 * (piece 2, docs/quota.md "Saved resets on their own"), the spent first mate
 * has a reset used with no click once the decision model, here a Jev
 * stand-in (`jevStandIn.ts`), answers use.
 */

/** The live Codex reading's saved resets (`tests/fixtures/quota-credits`), here applying now. */
const LIVE = JSON.parse(
  readFileSync(
    new URL("../fixtures/quota-credits/codex-usage-credits.json", import.meta.url),
    "utf8",
  ),
) as { rate_limit_reset_credits: { available_count: number } };
const HELD = LIVE.rate_limit_reset_credits.available_count;

/** Both seats' allowance readings: Claude and Codex spent, Codex holding saved resets that apply now. */
function spentReadings(now: number, held = HELD): string {
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
        savedResets: { available: held, applicable: held },
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

/** The address a browser ends on once ChatGPT approves a sign-in whose page was `link`. */
function browserEndsOn(link: string, code: string): string {
  const asked = new URL(link);
  const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
  back.search = new URLSearchParams({
    code,
    state: asked.searchParams.get("state") ?? "",
  }).toString();
  return back.toString();
}

test("Use a saved reset on a spent Codex seat's card signs Codex in on the account's row, by keys, and uses the reset that expires first", async () => {
  test.setTimeout(3 * 60_000);
  const now = Date.now();
  const second = Math.floor(now / 1000);
  // Two saved resets: the one granted later expires sooner, so it is the one used.
  const codex = writeMockCodexClient(scratchDir("infinitary-saved-reset-codex-"), {
    accountId: CODEX_SEAT_CHATGPT_ID,
    available: 2,
    credits: [
      { id: "reset-later", status: "available", expiresAt: second + 20 * 86_400 },
      { id: "reset-sooner", status: "available", expiresAt: second + 3 * 86_400 },
    ],
  });
  let mock: MockProviderServer | undefined;
  let launched: LaunchedApp | undefined;
  try {
    mock = await startMockProvider();
    launched = await launchClaudeSeat({
      mockProvider: mock,
      withCodex: true,
      env: {
        INFINITARY_QUOTA_FIXTURE_DIR: spentReadings(now, 2),
        INFINITARY_CODEX_CLI: codex.path,
      },
    });
    const { page } = launched;
    await recordOpens(launched);
    const label = (await page.evaluate(() => window.infinitary.accounts.list())).find(
      (account) => account.id === CODEX_SEAT_ACCOUNT,
    )?.label;
    await page.evaluate(
      (id) => window.infinitary.settings.setFirstmateModel({ provider: "openai-codex", id }),
      starterFor("openai-codex", "high"),
    );
    await say(page, "sound the channel");

    const title = firstmatePauseTitle("no_headroom", "Codex");
    await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
    // Codex keeps no sign-in for the account yet, so Enter lands on its row, which starts the use there.
    await pressKey(
      shownCard(page, title).getByRole("button", { name: m.cardUseSavedReset(), exact: true }),
      "Enter",
    );
    await expect(page.getByRole("tab", { name: "Intelligence", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Codex's own ChatGPT sign-in page opens, and the row asks for the address it ends on.
    await expect
      .poll(async () => (await opened(launched as LaunchedApp)).at(-1) ?? "")
      .toMatch(/^https:\/\/auth\.openai\.com\//);
    const link = (await opened(launched)).at(-1) as string;
    const paste = page.getByPlaceholder(m.accountsSavedResetPastePlaceholder());
    await expect(paste).toBeVisible();
    expect(codex.requests().map((request) => request.method)).not.toContain(
      "account/rateLimitResetCredit/consume",
    );
    await paste.fill(browserEndsOn(link, "e2e-chatgpt-code-5483"));
    await pressKey(paste, "Enter");

    // The reset that expires first is used, once, and the feed says how many are left.
    await expect
      .poll(() =>
        codex
          .requests()
          .some((request) => request.method === "account/rateLimitResetCredit/consume"),
      )
      .toBe(true);
    await leaveSettings(page);
    await expect(
      feedLineOf(page, {
        type: "firstmate_note",
        text: m.accountsSavedResetUsed({ account: `Codex · ${label}`, count: 1 }),
      }),
    ).toBeVisible({ timeout: 30_000 });
    const consumed = codex
      .requests()
      .filter((request) => request.method === "account/rateLimitResetCredit/consume");
    expect(consumed.map((request) => request.params?.creditId)).toEqual(["reset-sooner"]);
  } finally {
    await launched?.close();
    await mock?.close();
  }
});

test("Use a saved reset on a spent Codex seat's card, with Codex already signed in to the account, uses the reset that expires first at once, with no row and no browser", async () => {
  test.setTimeout(3 * 60_000);
  const now = Date.now();
  const second = Math.floor(now / 1000);
  const codex = writeMockCodexClient(scratchDir("infinitary-saved-reset-codex-"), {
    accountId: CODEX_SEAT_CHATGPT_ID,
    available: 2,
    credits: [
      { id: "reset-later", status: "available", expiresAt: second + 20 * 86_400 },
      { id: "reset-sooner", status: "available", expiresAt: second + 3 * 86_400 },
    ],
  });
  let mock: MockProviderServer | undefined;
  let launched: LaunchedApp | undefined;
  try {
    mock = await startMockProvider();
    launched = await launchClaudeSeat({
      mockProvider: mock,
      withCodex: true,
      env: {
        INFINITARY_QUOTA_FIXTURE_DIR: spentReadings(now, 2),
        INFINITARY_CODEX_CLI: codex.path,
      },
    });
    const { page } = launched;
    await recordOpens(launched);
    // Codex already keeps this account's sign-in in the account's own Codex home, as its sign-in leaves it.
    signInCodexHome(
      launched.userDataDir,
      "openai-codex",
      CODEX_SEAT_ACCOUNT,
      CODEX_SEAT_CHATGPT_ID,
    );
    const label = (await page.evaluate(() => window.infinitary.accounts.list())).find(
      (account) => account.id === CODEX_SEAT_ACCOUNT,
    )?.label;
    await page.evaluate(
      (id) => window.infinitary.settings.setFirstmateModel({ provider: "openai-codex", id }),
      starterFor("openai-codex", "high"),
    );
    await say(page, "sound the channel");

    const title = firstmatePauseTitle("no_headroom", "Codex");
    await expect(shownCard(page, title)).toBeVisible({ timeout: 45_000 });
    await pressKey(
      shownCard(page, title).getByRole("button", { name: m.cardUseSavedReset(), exact: true }),
      "Enter",
    );
    await expect(
      feedLineOf(page, {
        type: "firstmate_note",
        text: m.accountsSavedResetUsed({ account: `Codex · ${label}`, count: 1 }),
      }),
    ).toBeVisible({ timeout: 30_000 });
    const methods = codex.requests().map((request) => request.method);
    expect(methods).not.toContain("account/login/start");
    expect(
      codex
        .requests()
        .filter((request) => request.method === "account/rateLimitResetCredit/consume")
        .map((request) => request.params?.creditId),
    ).toEqual(["reset-sooner"]);
    expect(await opened(launched)).toEqual([]);
    await expect(page.locator("[data-settings-column]")).toHaveCount(0);
  } finally {
    await launched?.close();
    await mock?.close();
  }
});

test("Use saved resets on their own, turned on from a Codex row by keys, uses the reset that expires first when the first mate's allowance runs out", async () => {
  test.setTimeout(3 * 60_000);
  const now = Date.now();
  const second = Math.floor(now / 1000);
  const codex = writeMockCodexClient(scratchDir("infinitary-saved-reset-codex-"), {
    accountId: CODEX_SEAT_CHATGPT_ID,
    available: 2,
    credits: [
      { id: "reset-later", status: "available", expiresAt: second + 20 * 86_400 },
      { id: "reset-sooner", status: "available", expiresAt: second + 3 * 86_400 },
    ],
  });
  let mock: MockProviderServer | undefined;
  let launched: LaunchedApp | undefined;
  let jev: JevStandIn | undefined;
  try {
    // The decision model answers use for the saved-reset question.
    jev = await startJevStandIn((id) => (id === "reset" ? "use" : undefined));
    mock = await startMockProvider();
    launched = await launchClaudeSeat({
      mockProvider: mock,
      withCodex: true,
      env: {
        INFINITARY_QUOTA_FIXTURE_DIR: spentReadings(now, 2),
        INFINITARY_CODEX_CLI: codex.path,
        INFINITARY_JEV_URL: jev.url,
      },
    });
    const { page } = launched;
    await answerDecisionsWithJev(page);
    await recordOpens(launched);
    signInCodexHome(
      launched.userDataDir,
      "openai-codex",
      CODEX_SEAT_ACCOUNT,
      CODEX_SEAT_CHATGPT_ID,
    );
    const label = (await page.evaluate(() => window.infinitary.accounts.list())).find(
      (account) => account.id === CODEX_SEAT_ACCOUNT,
    )?.label;

    // The captain turns the switch on from the account's row menu, by keys.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    const row = page.locator(`[data-account-row="${CODEX_SEAT_ACCOUNT}"]`);
    await pressKey(row.getByRole("button", { name: /actions$/ }), "Enter");
    const item = page.locator('[data-menu-item="use-saved-resets"]');
    await expect(item).toContainText(m.settingsSubscriptionsMenuUseResets());
    await expect(item).toContainText(m.settingsSubscriptionsMenuUseResetsDetail());
    for (let press = 0; press < 12; press++) {
      if (await item.evaluate((node) => node === document.activeElement)) break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(item).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.accounts.list())).find(
            (account) => account.id === CODEX_SEAT_ACCOUNT,
          )?.useSavedResets,
      )
      .toBe(true);
    // Turning it on uses nothing.
    expect(codex.requests().map((request) => request.method)).not.toContain(
      "account/rateLimitResetCredit/consume",
    );
    await leaveSettings(page);

    // The first mate on Codex runs out; its decision answers use, and the reset is used with no click.
    await page.evaluate(
      (id) => window.infinitary.settings.setFirstmateModel({ provider: "openai-codex", id }),
      starterFor("openai-codex", "high"),
    );
    await say(page, "sound the channel");
    await expect(
      feedLineOf(page, {
        type: "firstmate_note",
        text: m.accountsSavedResetUsedAuto({ account: `Codex · ${label}`, count: 1 }),
      }),
    ).toBeVisible({ timeout: 45_000 });
    expect(
      codex
        .requests()
        .filter((request) => request.method === "account/rateLimitResetCredit/consume")
        .map((request) => request.params?.creditId),
    ).toEqual(["reset-sooner"]);
    expect(await opened(launched)).toEqual([]);
    // It was asked once, with the waiting work and the resets that apply now.
    const asked = jev.asked.filter((question) => question.id === "reset");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.state.waiting_work).toBe("first mate");
    expect(String(asked[0]?.state.saved_resets_that_apply_now)).toBe("2");
  } finally {
    await launched?.close();
    await mock?.close();
    await jev?.close();
  }
});
