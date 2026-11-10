/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/claude/
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, type LaunchOptions, launchApp } from "./launch";
import { signedInClaudeHome } from "./mockClaudeClient";

/** INF-2394: seed through the owner and prove the connected-account prerequisite on every launch. */
export async function launchSignedInClaude(
  accountId: string,
  options: LaunchOptions,
  preserveCredentials = false,
): Promise<LaunchedApp> {
  const app = await launchApp({
    ...options,
    prepareHome: (homeDir) => {
      signedInClaudeHome(homeDir, { preserveCredentials });
      options.prepareHome?.(homeDir);
    },
  });
  try {
    await expectClaudeConnected(app.page, accountId);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

/** INF-2384: connected-Claude journeys must reach the real account health path. */
export async function expectClaudeConnected(page: Page, accountId: string): Promise<void> {
  const reading = await page.evaluate(async (id) => {
    const account = (await window.infinitary.accounts.list()).find((each) => each.id === id);
    const slots = await window.infinitary.models.slots();
    return {
      accountId: id,
      connected: account?.connected,
      models: [...slots.models, ...slots.byName]
        .filter((model) => model.provider === "anthropic-claude")
        .map(({ id, label, slots }) => ({ id, label, slots })),
    };
  }, accountId);
  await test.info().attach("claude-account-prerequisite", {
    body: JSON.stringify(reading, null, 2),
    contentType: "application/json",
  });
  expect(reading.connected).toBe(true);
}

/**
 * A HOME whose own Claude Code settings name a gateway, as a company's
 * gateway hands them out: a token command printing `token` and the
 * `address` it is sent to, beside keys the app must leave out
 * (`src/core/claude/claudeAccess.ts` reads it). No Claude login is in it.
 */
export function claudeSettingsGateway(address: string, token: string) {
  return (homeDir: string): void => {
    const bin = join(homeDir, "bin");
    mkdirSync(bin, { recursive: true });
    const command = join(bin, "gateway-token");
    writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${token}'\n`);
    chmodSync(command, 0o755);
    const claude = join(homeDir, ".claude");
    mkdirSync(claude, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(claude, "settings.json"),
      `${JSON.stringify(
        {
          apiKeyHelper: command,
          env: { ANTHROPIC_BASE_URL: address, DISABLE_TELEMETRY: "1" },
          model: "opus",
        },
        null,
        2,
      )}\n`,
    );
  };
}
