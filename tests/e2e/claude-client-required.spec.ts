import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  FIRSTMATE_FAILURE_TITLE,
  firstmatePauseTitle,
} from "../../src/core/orchestrator/cardService";
import { CLAUDE_FIRST_RUN_TEXT } from "../../src/renderer/src/settings/subscriptionsWords";
import {
  CLAUDE_CHIP_INSTALL_NOTE,
  CLAUDE_CLIENT_MISSING_TEXT,
  claudeClientOutdatedText,
} from "../../src/shared/claudeClient";
import { scratchDir } from "../helpers/scratchDirs";
import { claudeSeatRequests, launchClaudeSeat, say } from "./claudeSeat";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { signedInClaudeHome, writeMockClaudeClient } from "./mockClaudeClient";
import {
  ANSWER_PROMPT_MARKER,
  mockProviderOverrideModelsJson,
  startMockProvider,
} from "./mockProvider";
import { expectNoCard, shownCard } from "./stack";

/**
 * F14 (captain lock 2026-09-20): the app ships no Claude client and downloads
 * none - it runs the Claude Code the person installed. These tests are the
 * product-level evidence for the two ways that can fail:
 *
 *  - no client on the machine: the account is NOT signed out (its credential
 *    is fine), the row says what to do, and no Claude model is served;
 *  - a client older than the SDK's own: the row names both versions.
 *
 * And for the Firstmate on Claude (W1 S12): its seat pauses on the client's
 * own sentence rather than failing, and a Mac with only Claude says on the
 * first-launch stage why the gate is still up.
 *
 * "No client" is `INFINITARY_CLAUDE_CLI` naming a path that is not there - the
 * launch helper otherwise gives every run the stub, so a developer's real
 * client is never spawned by a test, and a missing override is deliberately
 * "no client", never a fallback to whatever is installed.
 */

const CLAUDE_PERSONAL = "acct_claude_f14";

function seedClaudeAccount(userDataDir: string) {
  const accountsDir = join(userDataDir, "accounts");
  mkdirSync(join(accountsDir, "anthropic-claude", CLAUDE_PERSONAL), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: CLAUDE_PERSONAL,
          providerId: "anthropic-claude",
          kind: "subscription_oauth",
          label: "Personal",
          enabled: true,
          createdAt: Date.parse("2026-08-01T00:00:00Z"),
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
}

async function openIntelligence(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
}

test("a signed-in Claude account on a Mac with no Claude Code is not ready, not signed out", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedClaudeAccount(userDataDir);
  const app = await launchApp({
    withMockProvider: true,
    userDataDir,
    // The machine's own login is on file; only the client is gone.
    prepareHome: signedInClaudeHome,
    env: { INFINITARY_CLAUDE_CLI: join(userDataDir, "no-such-client") },
  });
  try {
    await openIntelligence(app.page);
    const row = app.page.locator(`[data-account-row="${CLAUDE_PERSONAL}"]`);
    await expect(row.getByText(CLAUDE_CLIENT_MISSING_TEXT)).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole("img", { name: "not ready" })).toBeVisible();
    // Never a sign-out: no sign-in affordance, no error copy, no meter.
    await expect(row.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    await expect(row.getByText("Sign in again.")).toHaveCount(0);
    await expect(row.getByText(CLAUDE_FIRST_RUN_TEXT)).toHaveCount(0);
    await expect(row.getByTestId("quota-micro-meter")).toHaveCount(0);
    const titles = await app.page.evaluate(async () =>
      (await window.infinitary.cards.list()).map((card) => card.title),
    );
    expect(titles.some((title) => /sign in again/i.test(title))).toBe(false);

    // The account serves no model: a spawn could only fail.
    const available = await app.page.evaluate(() => window.infinitary.models.available());
    expect(
      available.filter((model: { provider: string }) => model.provider === "anthropic-claude"),
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a Claude Code older than the SDK's own is named with both versions", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedClaudeAccount(userDataDir);
  const app = await launchApp({
    withMockProvider: true,
    userDataDir,
    prepareHome: signedInClaudeHome,
    env: {
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "old-client"), {
        version: "1.0.0",
      }),
    },
  });
  try {
    await openIntelligence(app.page);
    const row = app.page.locator(`[data-account-row="${CLAUDE_PERSONAL}"]`);
    // The floor is whatever the SDK in this checkout was released with; the
    // sentence names it, so match the shape and the installed version.
    await expect(
      row.getByText(/^Claude Code 1\.0\.0 is installed; \d+\.\d+\.\d+ or newer is needed\./),
    ).toBeVisible({
      timeout: 15_000,
    });
    const text = await row.getByText(/Claude Code 1\.0\.0 is installed/).textContent();
    const floor = /; (\d+\.\d+\.\d+) or newer/.exec(text ?? "")?.[1];
    expect(floor).toBeTruthy();
    expect(text).toBe(claudeClientOutdatedText("1.0.0", floor ?? ""));
    await expect(row.getByRole("img", { name: "not ready" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    const available = await app.page.evaluate(() => window.infinitary.models.available());
    expect(
      available.filter((model: { provider: string }) => model.provider === "anthropic-claude"),
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

test("with no Claude Code and no account, the Claude chip is disabled with the install note", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  const app = await launchApp({
    withMockProvider: true,
    userDataDir,
    env: { INFINITARY_CLAUDE_CLI: join(userDataDir, "no-such-client") },
  });
  try {
    await openIntelligence(app.page);
    const chip = app.page.getByRole("button", { name: "Connect Claude" });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toBeDisabled();
    await expect(chip).toHaveAccessibleDescription(CLAUDE_CLIENT_MISSING_TEXT);
    await expect(chip.getByText(CLAUDE_CHIP_INSTALL_NOTE)).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a Firstmate on Claude whose Claude Code is gone pauses with the client's sentence, and asks to move", async () => {
  const mockProvider = await startMockProvider();
  const homeDir = scratchDir("infinitary-home-");
  let app = await launchClaudeSeat({ mockProvider, homeDir, withCodex: true });
  const { userDataDir } = app;
  await app.close();
  // Claude Code was removed from this Mac while the app was closed.
  app = await launchClaudeSeat({
    mockProvider,
    userDataDir,
    homeDir,
    env: { INFINITARY_CLAUDE_CLI: join(userDataDir, "no-such-client") },
  });
  try {
    const words = `check the bilge ${ANSWER_PROMPT_MARKER}`;
    await say(app.page, words);
    const title = firstmatePauseTitle("client", "Claude");
    await expect(shownCard(app.page, title)).toBeVisible({ timeout: 45_000 });
    const body = cardBody(app.page, title);
    await expect(body.getByText(CLAUDE_CLIENT_MISSING_TEXT, { exact: false })).toBeVisible();
    await expect(app.page.getByRole("button", { name: "Move to Codex" })).toBeVisible();
    await expectNoCard(app.page, FIRSTMATE_FAILURE_TITLE);
    await app.page.screenshot({ path: test.info().outputPath("claude-seat-client-missing.png") });
    // Nothing reached a model: the words wait for Claude Code, or the move.
    expect(claudeSeatRequests(mockProvider).filter((entry) => entry.includes(words))).toEqual([]);
  } finally {
    await app.close();
    await mockProvider.close();
  }
});

test("with only Claude and no Claude Code, the stage says why the gate is still up", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedClaudeAccount(userDataDir);
  const app = await launchApp({
    withMockProvider: true,
    modelsJson: mockProviderOverrideModelsJson,
    userDataDir,
    prepareHome: signedInClaudeHome,
    env: { INFINITARY_CLAUDE_CLI: join(userDataDir, "no-such-client") },
  });
  try {
    const gate = app.page.locator("[data-first-run-gate]");
    await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
    const claude = gate.locator(`[data-connect-account="anthropic-claude"]`);
    await expect(claude).toHaveAttribute("data-unavailable", "true", { timeout: 15_000 });
    await expect(claude.getByText(CLAUDE_CHIP_INSTALL_NOTE)).toBeVisible();
    await expect(claude).toHaveAccessibleDescription(CLAUDE_CLIENT_MISSING_TEXT);
    await app.page.screenshot({
      path: test.info().outputPath("first-launch-claude-no-client.png"),
    });
  } finally {
    await app.close();
  }
});
