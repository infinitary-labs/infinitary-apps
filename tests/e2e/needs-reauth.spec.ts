import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { KEYCHAIN_VALUE_FAILURE_DETAIL } from "../../src/shared/quota";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { expectClaudeConnected, launchSignedInClaude } from "./claudeAccount";
import { writeMockClaudeClient } from "./mockClaudeClient";

/**
 * CD-3=A: the terminal needs_reauth state is a card plus the Subscriptions
 * CTA, reached only from proof (its journey runs the real sensor in
 * quota-live-sensor.spec.ts). A retryable miss stays a Retry, never "sign in
 * again".
 */

const CLAUDE_PERSONAL = "acct_claude_reauth";

function seedClaudeAccount(userDataDir: string) {
  seedAccountStore(userDataDir, "anthropic-claude", CLAUDE_PERSONAL, {
    recursive: true,
    mode: 0o700,
  });
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: CLAUDE_PERSONAL,
        providerId: "anthropic-claude",
        kind: "subscription_oauth",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
    ],
    {},
    { mode: 0o600 },
  );
}

function writeQuotaFixture(
  dir: string,
  provider: {
    status: string;
    reason?: string;
    detail?: string;
  },
) {
  writeFileSync(
    join(dir, "snapshot.json"),
    JSON.stringify({
      generatedAt: "2026-09-10T00:00:00.000Z",
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: CLAUDE_PERSONAL,
          accountLabel: "Personal",
          stale: false,
          windows: [],
          ...provider,
        },
      ],
    }),
  );
}

async function cardTitles(page: { evaluate: (fn: () => Promise<string[]>) => Promise<string[]> }) {
  return page.evaluate(async () =>
    (await window.infinitary.cards.list()).map((card) => card.title),
  );
}

test("a locked store says so, offers Retry, and never asks for Always Allow", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  const fixtureDir = scratchDir("infinitary-quota-fixture-");
  seedClaudeAccount(userDataDir);
  writeQuotaFixture(fixtureDir, {
    status: "unavailable",
    reason: "keychain_locked",
    detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_locked,
  });
  const app = await launchSignedInClaude(CLAUDE_PERSONAL, {
    userDataDir,
    env: {
      INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir,
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")),
    },
  });
  try {
    await expectClaudeConnected(app.page, CLAUDE_PERSONAL);
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("tab", { name: "Intelligence" }).click();
    const row = app.page.locator(`[data-account-row="${CLAUDE_PERSONAL}"]`);
    // The truth: locked, and Retry is what asks macOS to unlock it. No grant
    // dialog appears for a locked store, so no "Always Allow".
    await expect(row.getByText(KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_locked)).toBeVisible({
      timeout: 15_000,
    });
    await expect(row.getByText(/Always Allow/)).toHaveCount(0);
    await expect(row.getByText(/keychain/i)).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    const titles = await cardTitles(app.page);
    expect(titles.some((title) => /needs you to sign in again/i.test(title))).toBe(false);
    await row.screenshot({ path: test.info().outputPath("dark-settings-claude-locked-store.png") });
  } finally {
    await app.close();
  }
});
