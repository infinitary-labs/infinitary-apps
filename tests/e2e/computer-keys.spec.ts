import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { GROK_CREDITS_LABEL } from "../../src/core/quota/providers/grok";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { openModelsBoard } from "./modelsBoard";
import { regionShot } from "./pictures";

/**
 * A key set on the computer signs no account in. Pi's key sign-in for Grok,
 * OpenRouter, Kimi Code and Copilot reads XAI_API_KEY, OPENROUTER_API_KEY,
 * KIMI_API_KEY and COPILOT_GITHUB_TOKEN when an account's store holds
 * nothing, and a Windows app, or one started from a terminal, keeps those
 * variables. Each allowance reading goes to one local stand-in that answers
 * any key the way the provider answers a working one, so a computer's key
 * that reached a meter would show as a reading; nothing reaches a provider.
 */

const COMPUTER_KEYS = {
  XAI_API_KEY: "grok-key-on-the-computer",
  OPENROUTER_API_KEY: "openrouter-key-on-the-computer",
  KIMI_API_KEY: "kimi-key-on-the-computer",
  COPILOT_GITHUB_TOKEN: "copilot-token-on-the-computer",
};
const STORED_GROK_KEY = "grok-key-stored-by-the-person";

const SIGNED_IN = "acct_grok_stored_key";
const KEYLESS = [
  { id: "acct_grok_keyless", providerId: "xai", kind: "api_key" },
  { id: "acct_openrouter_keyless", providerId: "openrouter", kind: "api_key" },
  { id: "acct_kimi_keyless", providerId: "kimi-coding", kind: "subscription_oauth" },
  { id: "acct_copilot_keyless", providerId: "github-copilot", kind: "subscription_oauth" },
] as const;

const PATHS = {
  grokKey: "/v1/api-key",
  grokUsage: "/rest/subscriptions",
  kimi: "/coding/v1/usages",
  copilot: "/copilot_internal/user",
};

type Meters = { server: Server; base: string; seen: string[] };

async function standInMeters(): Promise<Meters> {
  const meters: Meters = { server: createServer(), base: "", seen: [] };
  meters.server.on("request", (request, response) => {
    request.resume();
    request.on("end", () => {
      meters.seen.push((request.headers.authorization ?? "").replace(/^Bearer /, ""));
      const reply = (body: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
      if (request.url === PATHS.grokKey) return reply({ remaining_credits: 40, credit_limit: 100 });
      if (request.url === PATHS.kimi)
        return reply({
          usages: {
            limit_5h: { used_ratio: 0.3, reset_time: at(3) },
            limit_7d: { used_ratio: 0.1, reset_time: at(5 * 24) },
            limit_month_total: { used_ratio: 0.05, reset_time: at(20 * 24) },
          },
          user: { membership: { level: "LEVEL_INTERMEDIATE" } },
          version: "GOODS_VERSION_V1",
        });
      if (request.url === PATHS.copilot) {
        const unlimited = (quota_id: string) => ({
          entitlement: 0,
          overage_count: 0,
          overage_permitted: false,
          percent_remaining: 100,
          quota_id,
          quota_remaining: 0,
          remaining: 0,
          unlimited: true,
        });
        return reply({
          access_type_sku: "monthly_subscriber_quota",
          chat_enabled: true,
          copilot_plan: "individual",
          quota_reset_date: at(20 * 24).slice(0, 10),
          quota_snapshots: {
            chat: unlimited("chat"),
            completions: unlimited("completions"),
            premium_interactions: {
              entitlement: 300,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 62,
              quota_id: "premium_interactions",
              quota_remaining: 186,
              remaining: 186,
              unlimited: false,
            },
          },
        });
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => meters.server.listen(0, "127.0.0.1", resolve));
  meters.base = `http://127.0.0.1:${(meters.server.address() as AddressInfo).port}`;
  return meters;
}

function seedAccounts(userDataDir: string) {
  seedAccountStore(userDataDir, "xai", SIGNED_IN);
  seedAccountAuth(userDataDir, "xai", SIGNED_IN, {
    xai: { type: "api_key", key: STORED_GROK_KEY },
  });
  for (const account of KEYLESS) {
    seedAccountStore(userDataDir, account.providerId, account.id);
    seedAccountAuth(userDataDir, account.providerId, account.id, {});
  }
  const createdAt = Date.parse("2026-11-20T00:00:00Z");
  seedAccountRegistry(userDataDir, [
    {
      id: SIGNED_IN,
      providerId: "xai",
      kind: "api_key",
      label: "Personal",
      enabled: true,
      createdAt,
    },
    ...KEYLESS.map((account, index) => ({
      ...account,
      label: "Work",
      enabled: true,
      createdAt: createdAt + index + 1,
    })),
  ]);
}

async function openIntelligence(app: LaunchedApp) {
  await app.page.getByRole("button", { name: "Settings" }).click();
  await app.page.getByRole("tab", { name: "Intelligence" }).click();
}

function accountRow(app: LaunchedApp, accountId: string) {
  return app.page.locator(`[data-account-row="${accountId}"]`);
}

test.describe("keys set on the computer", () => {
  let app: LaunchedApp | undefined;
  let meters: Meters | undefined;

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    const server = meters?.server;
    meters = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("sign no account in, reach no meter and lend no account their models", async () => {
    test.setTimeout(180_000);
    meters = await standInMeters();
    const userDataDir = scratchDir("infinitary-e2e-");
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      env: {
        ...COMPUTER_KEYS,
        INFINITARY_GROK_KEY_URL: `${meters.base}${PATHS.grokKey}`,
        INFINITARY_GROK_USAGE_URL: `${meters.base}${PATHS.grokUsage}`,
        INFINITARY_KIMI_USAGE_URL: `${meters.base}${PATHS.kimi}`,
        INFINITARY_COPILOT_USAGE_URL: `${meters.base}${PATHS.copilot}`,
      },
    });
    await resizeWindow(app.app, app.page, { width: 1180, height: 900 });
    await openIntelligence(app);

    // The account with its own key reads its allowance, so the meters run.
    await expect(
      accountRow(app, SIGNED_IN).getByText(GROK_CREDITS_LABEL, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    for (const account of KEYLESS) {
      const row = accountRow(app, account.id);
      await expect(row.getByRole("button", { name: "Sign in" })).toBeVisible({ timeout: 30_000 });
    }
    await regionShot(
      app.page.locator("[data-subscriptions-list]"),
      test.info().outputPath("computer-keys-accounts.png"),
    );
    expect(meters.seen).toContain(STORED_GROK_KEY);
    for (const key of Object.values(COMPUTER_KEYS)) expect(meters.seen).not.toContain(key);

    // The signed-in Grok account's models are on the board, and no other
    // provider's are: the computer's keys lend it none.
    const models = await openModelsBoard(app.page);
    await expect(models.locator('[data-model-row^="xai/"]').first()).toBeVisible({
      timeout: 30_000,
    });
    for (const provider of ["openrouter", "kimi-coding", "github-copilot"])
      await expect(models.locator(`[data-model-row^="${provider}/"]`)).toHaveCount(0);
  });
});
