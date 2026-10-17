import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { NO_CLAUDE_LOGIN_USER } from "./claudeSeat";
import { type LaunchedApp, type LaunchOptions, launchApp } from "./launch";
import { mainProcessSettled } from "./mainProcess";
import {
  claudeDefaultStore,
  seedClaudeCredentialFile,
  seedSignedInClaudeStore,
} from "./mockClaudeClient";
import { MOCK_KEY_PROVIDER_ID, mockProviderOverrideModelsJson } from "./mockProvider";

/**
 * An app whose crew runs on Claude (W1 S5): two accounts - Claude for the
 * crew, and an OpenRouter key the captain put the Firstmate on (Claude can
 * seat it too since W1 S12; tests/e2e/claudeSeat.ts is that app) - with the
 * Firstmate's model slotted and pinned, and turn-mode Claude sessions
 * against the mock provider (tests/e2e/mockClaudeClient.ts).
 *
 * Hermetic for the person's own Claude login, as the seat's app is: the
 * app runs as NO_CLAUDE_LOGIN_USER, so its own Keychain lookups find
 * nothing, and the store keeps its credential in the plain file. While a
 * crewmate's client holds the store, the app's status read cannot ask the
 * client and reads that file instead (docs/e2e-contracts.md), so this
 * store alone says the crew's account is signed in, never the machine's.
 */

export const CLAUDE_CREW_ACCOUNT = "acct_claude_crew";
const FIRSTMATE_ACCOUNT = "acct_openrouter_crew";
const FIRSTMATE_MODEL_KEY = `${MOCK_KEY_PROVIDER_ID}/~openai/gpt-luna-latest`;

/**
 * The two accounts. The Firstmate's runtime reads the app-scoped
 * models.json that points OpenRouter at the mock provider. The Claude
 * account is vault bookkeeping only; its login lives in HOME/.claude
 * (CD-1=B).
 */
function seedAccounts(userDataDir: string): void {
  const accountsDir = join(userDataDir, "accounts");
  mkdirSync(join(accountsDir, "anthropic-claude", CLAUDE_CREW_ACCOUNT), {
    recursive: true,
    mode: 0o700,
  });
  const keyStore = join(accountsDir, MOCK_KEY_PROVIDER_ID, FIRSTMATE_ACCOUNT);
  mkdirSync(keyStore, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(keyStore, "auth.json"),
    JSON.stringify({ [MOCK_KEY_PROVIDER_ID]: { type: "api_key", key: "sk-or-mock-key" } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: FIRSTMATE_ACCOUNT,
          providerId: MOCK_KEY_PROVIDER_ID,
          kind: "api_key",
          label: "Personal",
          enabled: true,
          createdAt: Date.parse("2026-08-01T00:00:00Z"),
        },
        {
          id: CLAUDE_CREW_ACCOUNT,
          providerId: "anthropic-claude",
          kind: "subscription_oauth",
          label: "Personal",
          enabled: true,
          createdAt: Date.parse("2026-08-02T00:00:00Z"),
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
}

/**
 * Claude's allowance, from a fixture: the live sensor would read the
 * machine's own login to ask Anthropic, and this run must not.
 */
function writeQuotaFixture(now: number): string {
  const dir = scratchDir("infinitary-quota-fixture-");
  const HOUR = 3600 * 1000;
  writeFileSync(
    join(dir, "snapshot.json"),
    JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      fetchedAt: now,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: CLAUDE_CREW_ACCOUNT,
          accountLabel: "kun@example.com",
          status: "ok",
          stale: false,
          windows: [
            {
              id: "five_hour",
              label: "session",
              percentRemaining: 80,
              pace: "behind",
              resetText: "resets 6pm",
              resetsAtMs: now + 2 * HOUR,
              windowSeconds: 18_000,
            },
          ],
        },
      ],
    }),
  );
  return dir;
}

/**
 * The login the machine's Claude config names: an account in an
 * organisation. A spec swaps it between launches to change the login the
 * app reads at boot, as signing in to another account in Claude Code does.
 */
export function signedInAs(account: string): (homeDir: string) => void {
  return (homeDir) =>
    writeFileSync(
      join(homeDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: account,
          organizationUuid: "org-shipyard",
          emailAddress: "kun@example.com",
        },
      }),
    );
}

/**
 * Launch the app with its crew on Claude. A first launch - no accounts in
 * `userDataDir` yet, which a spec may have seeded with a project first -
 * seeds both accounts and a signed-in Claude store, and slots the
 * Firstmate's model; a relaunch keeps them, and `homeDir` keeps the Claude
 * store and its transcripts. `env` rides beside the allowance fixture's.
 */
export async function launchClaudeCrew(
  options: Pick<
    LaunchOptions,
    "userDataDir" | "homeDir" | "reuseMockProvider" | "prepareHome" | "claudeTurns" | "env"
  > = {},
): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? scratchDir("infinitary-e2e-");
  const relaunch = existsSync(join(userDataDir, "accounts", "registry.json"));
  if (!relaunch) seedAccounts(userDataDir);
  const launched = await launchApp({
    ...(options.reuseMockProvider
      ? { reuseMockProvider: options.reuseMockProvider }
      : { withMockProvider: true }),
    modelsJson: mockProviderOverrideModelsJson,
    claudeTurns: options.claudeTurns ?? true,
    userDataDir,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    prepareHome: (homeDir) => {
      seedSignedInClaudeStore(claudeDefaultStore(homeDir));
      // Signed in, as the client and the store both say, on every platform:
      // the app's status read falls back to the store's credentials file
      // while a crewmate's client holds the store, and the Keychain holds
      // nothing for this run's user. The allowance fixture keeps the quota
      // sensor from using its fake tokens.
      seedClaudeCredentialFile(claudeDefaultStore(homeDir));
      options.prepareHome?.(homeDir);
    },
    env: {
      USER: NO_CLAUDE_LOGIN_USER,
      ...options.env,
      INFINITARY_QUOTA_FIXTURE_DIR: writeQuotaFixture(Date.now()),
    },
  });
  if (relaunch) {
    await mainProcessSettled(launched.app);
    return launched;
  }
  // Claude's starter slots are the only slotted models until the captain
  // gives OpenRouter one (it has no starter slots): slot one OpenRouter
  // model the way the Intelligence tab does, and put the Firstmate on it
  // the way its picker does, so the crew is Claude's alone.
  const { page } = launched;
  const slotted = () =>
    page.evaluate(async (key) => {
      const view = await window.infinitary.models.slots();
      return view.models.find((model) => `${model.provider}/${model.id}` === key)?.slots ?? null;
    }, FIRSTMATE_MODEL_KEY);
  // The model has to be in the pool before it can take a slot.
  await expect.poll(slotted, { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(
    (key) => window.infinitary.models.setSlotMembership(key, "medium", true),
    FIRSTMATE_MODEL_KEY,
  );
  await expect.poll(slotted).toEqual(["medium"]);
  await page.evaluate((key) => {
    const [provider, ...rest] = key.split("/");
    return window.infinitary.settings.setFirstmateModel({
      provider: provider as string,
      id: rest.join("/"),
    });
  }, FIRSTMATE_MODEL_KEY);
  // The window re-reads the first-run gate on each quota push (it follows
  // every account change); a slot change pushes none, so ask for one.
  await page.evaluate(() => window.infinitary.quota.refresh());
  await mainProcessSettled(launched.app);
  return launched;
}
