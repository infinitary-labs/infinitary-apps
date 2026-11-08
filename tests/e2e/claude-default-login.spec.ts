import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLAUDE_FIRST_RUN_TEXT } from "../../src/renderer/src/settings/subscriptionsWords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { starterFor } from "./starters";

/**
 * CD-1=B first-run: a missing machine Claude login is a real affordance,
 * not a dead meter or a "sign in again" error. The isolated desktop host
 * never reaches the person's real Keychain, even on service-only lookup.
 * These tests own the first-run affordance; pasted-code login is exercised
 * by the injected-backend tests and device-sign-ins journey.
 */

const CLAUDE_PERSONAL = "acct_claude_firstrun";

function seedDisconnectedClaude(userDataDir: string) {
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

test("a missing Claude login keeps the gate up and offers Sign in, never a sign-in-again", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedDisconnectedClaude(userDataDir);
  const app = await launchApp({
    userDataDir,
    env: { INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")) },
  });
  try {
    // Claude can run the Firstmate (W1), but not a login that is not signed
    // in: the first-launch gate stays up, and its Claude chip says it cannot.
    const gate = app.page.locator("[data-first-run-gate]");
    await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
    await expect(gate.locator(`[data-connect-account="anthropic-claude"]`)).toHaveAttribute(
      "data-unavailable",
      "true",
      { timeout: 15_000 },
    );

    // The way in is a first sign-in: the row offers it, and shows no meter
    // for an allowance nobody has read.
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("tab", { name: "Intelligence" }).click();
    const row = app.page.locator(`[data-account-row="${CLAUDE_PERSONAL}"]`);
    await expect(row.getByRole("button", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("quota-micro-meter")).toHaveCount(0);
    // First-run is not needs_reauth: nothing claims the login lapsed.
    const account = await app.page.evaluate(
      async (id) => (await window.infinitary.accounts.list()).find((each) => each.id === id),
      CLAUDE_PERSONAL,
    );
    expect(account).toMatchObject({ connected: false });
    expect(account?.needsReauth ?? false).toBe(false);
  } finally {
    await app.close();
  }
});

test("Connect Claude on a machine with no account is the first-run chip", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  const app = await launchApp({
    userDataDir,
    env: { INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")) },
  });
  try {
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("tab", { name: "Intelligence" }).click();
    await expect(app.page.getByRole("button", { name: "Connect Claude" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(app.page.getByText(CLAUDE_FIRST_RUN_TEXT)).toHaveCount(0);
    // Every Claude chip is that first-run chip, never the one that adds
    // another account: the chip is found by its provider, not its words.
    const claudeChips = app.page.locator('[data-connect-provider="anthropic-claude"]');
    await expect(claudeChips).not.toHaveCount(0);
    for (const chip of await claudeChips.all())
      await expect(chip).toHaveAccessibleName("Connect Claude");
    // Claude can run the Firstmate, but not without a login: picking a
    // Claude model says so, and pins nothing.
    const refusal = await app.page.evaluate(
      (id) =>
        window.infinitary.settings
          .setFirstmateModel({ provider: "anthropic-claude", id })
          .then(() => null)
          .catch((error: Error) => error.message),
      starterFor("anthropic-claude", "medium"),
    );
    expect(refusal).toContain("Claude is not connected.");
    const model = await app.page.evaluate(() => window.infinitary.settings.getFirstmateModel());
    expect(model?.provider).not.toBe("anthropic-claude");
  } finally {
    await app.close();
  }
});
