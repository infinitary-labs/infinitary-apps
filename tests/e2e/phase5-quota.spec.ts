import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ModelSlotsView, offeringKey } from "../../src/shared/modelSlots";
import type { ModelsCatalogView } from "../../src/shared/quota";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { expectClaudeConnected, launchSignedInClaude } from "./claudeAccount";
import type { LaunchedApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import {
  alwaysUseSwitch,
  levelLane,
  modelName,
  modelsSection,
  openModelPanel,
  removeFromAllLevels,
  setLevelInPanel,
} from "./modelsBoard";
import { type QuotaFixtureSnapshot, seedQuotaFixture } from "./quotaFixtures";
import { RETIRED_CURSOR_AUTH, seedRetiredCursorStore } from "./savedDataFixtures";
import { settingsSection } from "./settings";
import { starterFor } from "./starters";

/**
 * Phase 5 seams (docs/architecture.md §17 + the account broker): the
 * Subscriptions tab as ONE list of accounts (the Instruments relayout) -
 * per-account micro-meters via the injectable fixture seam and the crew
 * pin - plus catalog model pins and automatic model choice. The
 * user-facing surface never mentions the harness machinery.
 *
 * Claude rides its own backend (account-broker phase 7) and is exercised
 * here through a stand-in client, so the app runs its real spawn, its real
 * environment scoping and its real status parsing without a subscription, a
 * browser, or anyone being asked to sign in. A Cursor account an earlier
 * version signed in is left in the registry: Cursor is no longer offered
 * (captain, 2026-09-24), so it must be skipped without a trace on screen.
 */

const CODEX_PERSONAL = "acct_e2e1";
const CODEX_WORK = "acct_e2e2";
const GROK_PERSONAL = "acct_grok1";
const GROK_TEAM = "acct_grok2";
const CLAUDE_PERSONAL = "acct_claude1";
const LEFTOVER_CURSOR = "acct_cursor1";
/** The label an earlier version gave the leftover Cursor sign-in. */
const LEFTOVER_CURSOR_LABEL = "Personal Pro";

/**
 * The fixture carries real cycle evidence (resetsAtMs/windowSeconds) with
 * resets in the FUTURE relative to the run, so the renderer's derived
 * quota path - effective headline, runway verdict, clock markers - is
 * exercised live rather than degrading to text-only meters.
 */
function buildQuotaFixture(now: number): QuotaFixtureSnapshot {
  const HOUR = 3600 * 1000;
  return {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        accountId: CODEX_PERSONAL,
        accountLabel: "Personal",
        plan: "Plus",
        account: "kun@example.com",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "session",
            label: "session",
            percentRemaining: 74,
            resetText: "resets 3pm",
            pace: "behind",
            // 2h of the 5h cycle left: reserve +34, comfortably behind.
            resetsAtMs: now + 2 * HOUR,
            windowSeconds: 18_000,
          },
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 9,
            resetText: "resets Fri",
            // 5 of 7 days left with 91% burned: cycle-average burn exhausts
            // this window long before its reset - the "empty in" verdict.
            pace: "ahead",
            resetsAtMs: now + 5 * 24 * HOUR,
            windowSeconds: 604_800,
          },
        ],
      },
      {
        provider: "codex",
        label: "Codex",
        accountId: CODEX_WORK,
        accountLabel: "Work #2",
        plan: "Pro",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 46,
            resetText: "resets Wed",
            pace: "ahead",
          },
        ],
      },
      {
        provider: "claude",
        label: "Claude",
        accountId: CLAUDE_PERSONAL,
        accountLabel: "kun@example.com",
        status: "ok",
        stale: false,
        // The regression seat for the captain's missing-quota bug: a
        // signed-in Claude with readable windows renders quota like any
        // other subscription. Both windows reach their own resets at the
        // observed burn, so the headline verdict is "on pace ✓".
        windows: [
          {
            id: "five_hour",
            label: "session",
            percentRemaining: 68,
            pace: "behind",
            resetText: "resets 6pm",
            resetsAtMs: now + 2 * HOUR,
            windowSeconds: 18_000,
          },
          {
            id: "seven_day",
            label: "weekly",
            percentRemaining: 31,
            pace: "behind",
            resetText: "resets Mon",
            resetsAtMs: now + 12 * HOUR,
            windowSeconds: 604_800,
          },
        ],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: GROK_PERSONAL,
        accountLabel: "Personal",
        plan: "SuperGrok",
        status: "ok",
        stale: true,
        windows: [{ id: "credits", label: "credits", percentRemaining: 57 }],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: GROK_TEAM,
        accountLabel: "Team",
        status: "ok",
        // Signed in, and the read carried no window: the row says so.
        stale: false,
        windows: [],
      },
    ],
  };
}

/** The quota reader's model catalog: models Codex really serves, from the starter map. */
const MODELS_FIXTURE: ModelsCatalogView = {
  generatedAt: "2026-08-13T20:00:00Z",
  models: [
    {
      provider: "codex",
      id: starterFor("openai-codex", "high"),
      label: starterFor("openai-codex", "high"),
      effectivePercentRemaining: 62,
    },
    {
      provider: "codex",
      id: starterFor("openai-codex", "low"),
      label: starterFor("openai-codex", "low"),
    },
  ],
};

/**
 * Seed the account store matrix the way the vault lays it out: an isolated
 * store per account with a provider-shaped credential file (fake values;
 * everything stays on the throwaway userData dir).
 */
function seedAccounts(userDataDir: string): void {
  const seed = (
    providerId: string,
    accountId: string,
    credential: Record<string, unknown>,
  ): void => {
    seedAccountStore(userDataDir, providerId, accountId, { recursive: true, mode: 0o700 });
    seedAccountAuth(
      userDataDir,
      providerId,
      accountId,
      { [providerId]: credential },
      {
        mode: 0o600,
      },
    );
  };
  const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
  seed("openai-codex", CODEX_PERSONAL, {
    type: "oauth",
    access: "fake-access-1",
    refresh: "fake-refresh-1",
    expires: farFuture,
  });
  seed("openai-codex", CODEX_WORK, {
    type: "oauth",
    access: "fake-access-2",
    refresh: "fake-refresh-2",
    expires: farFuture,
  });
  seed("xai", GROK_PERSONAL, { type: "api_key", key: "xai-fake-key" });
  seed("xai", GROK_TEAM, { type: "api_key", key: "xai-team-key" });
  // Vault bookkeeping only; the login lives in HOME/.claude (CD-1=B).
  seedAccountStore(userDataDir, "anthropic-claude", CLAUDE_PERSONAL, {
    recursive: true,
    mode: 0o700,
  });
  // What an earlier version left for a Cursor sign-in: the client's own
  // store under the account's directory. Nothing may read or delete it.
  seedRetiredCursorStore(userDataDir, LEFTOVER_CURSOR);
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: CODEX_PERSONAL,
        providerId: "openai-codex",
        kind: "subscription_oauth",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
      {
        id: CODEX_WORK,
        providerId: "openai-codex",
        kind: "subscription_oauth",
        label: "Work #2",
        enabled: true,
        createdAt: Date.parse("2026-08-02T00:00:00Z"),
      },
      {
        id: GROK_PERSONAL,
        providerId: "xai",
        kind: "api_key",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-03T00:00:00Z"),
      },
      {
        id: GROK_TEAM,
        providerId: "xai",
        kind: "api_key",
        label: "Team",
        enabled: true,
        createdAt: Date.parse("2026-08-03T12:00:00Z"),
      },
      {
        id: CLAUDE_PERSONAL,
        providerId: "anthropic-claude",
        kind: "subscription_oauth",
        label: "Personal Max",
        enabled: true,
        createdAt: Date.parse("2026-08-04T00:00:00Z"),
      },
      {
        id: LEFTOVER_CURSOR,
        providerId: "cursor",
        kind: "subscription_oauth",
        label: LEFTOVER_CURSOR_LABEL,
        enabled: true,
        createdAt: Date.parse("2026-08-05T00:00:00Z"),
      },
    ],
    { cursor: LEFTOVER_CURSOR },
    { mode: 0o600 },
  );
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  const fixtureDir = seedQuotaFixture(
    scratchDir("infinitary-quota-fixture-"),
    buildQuotaFixture(Date.now()),
    MODELS_FIXTURE,
  );
  const userDataDir = scratchDir("infinitary-e2e-");
  seedAccounts(userDataDir);
  const claudeClient = writeMockClaudeClient(scratchDir("infinitary-claude-stub-"));
  launched = await launchSignedInClaude(CLAUDE_PERSONAL, {
    withMockProvider: true,
    userDataDir,
    env: {
      INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir,
      INFINITARY_CLAUDE_CLI: claudeClient,
    },
  });
  // The flagship pin is a persisted setting; mark Personal as Firstmate's.
  await launched.page.evaluate(
    (accountId) => window.infinitary.settings.setFirstmateAccount(accountId),
    CODEX_PERSONAL,
  );
  await expectClaudeConnected(launched.page, CLAUDE_PERSONAL);
  await launched.page.getByRole("button", { name: "Settings" }).click();
  await launched.page.getByRole("tab", { name: "Intelligence" }).click();
});

test.afterAll(async () => {
  await launched.close();
});

test("Claude shows its allowance like any subscription, with no sign of its client", async () => {
  const { page } = launched;
  // The regression seat for the missing-quota gap: a signed-in Claude with
  // readable windows shows each of them, the person's own numbers.
  const claude = page.locator(`[data-account-row="${CLAUDE_PERSONAL}"]`);
  const meters = claude.getByTestId("quota-micro-meter");
  await expect(meters).toHaveCount(2, { timeout: 15_000 });
  for (const percent of ["68", "31"]) {
    await expect(meters.filter({ hasText: percent })).toBeVisible();
  }

  // The standing product rule (AGENTS.md): the user connects "Claude" and
  // never meets the machinery that reaches it. This is the assertion that
  // enforces it - each term is one the implementation could easily leak -
  // and no internal account id reaches the surface either.
  for (const machinery of [
    /harness/i,
    /runtime/i,
    /claude-agent-sdk/i,
    /agent sdk/i,
    /claude code/i,
    /CLAUDE_CONFIG_DIR/i,
    /config dir/i,
    /backend/i,
    /transport/i,
    /\bCLI\b/,
    /anthropic-claude/i,
    /acct_/,
  ]) {
    await expect(page.getByText(machinery)).toHaveCount(0);
  }
});

test("a Cursor account from an earlier version is skipped, and its store is kept", async () => {
  const { page, userDataDir } = launched;
  // The other rows are up, so the list has settled.
  await expect(page.locator(`[data-account-row="${CLAUDE_PERSONAL}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(`[data-account-row="${LEFTOVER_CURSOR}"]`)).toHaveCount(0);
  const intelligence = settingsSection(page, "subscriptions");
  await expect(intelligence).toBeVisible();
  await expect(intelligence.getByText(LEFTOVER_CURSOR_LABEL)).toHaveCount(0);
  await expect(intelligence.getByText("Cursor", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-connect-provider="cursor"]')).toHaveCount(0);
  const accounts = await page.evaluate(() => window.infinitary.accounts.list());
  expect(accounts.map((account) => account.id)).not.toContain(LEFTOVER_CURSOR);
  const pool = await page.evaluate(() => window.infinitary.models.available());
  expect(pool.some((model) => model.provider === "cursor")).toBe(false);

  // Nothing can bind to it either: the Firstmate refuses it as gone.
  const refusal = await page.evaluate(
    (accountId) =>
      window.infinitary.settings
        .setFirstmateAccount(accountId)
        .then(() => null)
        .catch((error: Error) => error.message),
    LEFTOVER_CURSOR,
  );
  expect(refusal).toContain("That account no longer exists.");
  const bound = await page.evaluate(() => window.infinitary.settings.getFirstmateAccount());
  expect(bound).toBe(CODEX_PERSONAL);

  // And nothing was deleted: the store and its registry row stay on disk.
  const authFile = join(userDataDir, "accounts", "cursor", LEFTOVER_CURSOR, ".cursor", "auth.json");
  expect(existsSync(authFile)).toBe(true);
  expect(readFileSync(authFile, "utf8")).toBe(RETIRED_CURSOR_AUTH);
  const registry = JSON.parse(
    readFileSync(join(userDataDir, "accounts", "registry.json"), "utf8"),
  ) as { accounts: { id: string }[] };
  expect(registry.accounts.map((account) => account.id)).toContain(LEFTOVER_CURSOR);
});

test("the account pin toggles and persists", async () => {
  const { page } = launched;
  const work = page.locator(`[data-account-row="${CODEX_WORK}"]`);
  const preferred = async () =>
    (await page.evaluate(() => window.infinitary.accounts.list()))
      .filter((account) => account.pinned)
      .map((account) => account.id);
  await expect(page.locator("[data-crew-preferred]")).toHaveCount(0);
  await work.getByRole("button", { name: "Work #2 actions" }).click();
  await page.locator('[data-menu-item="prefer"]').click();
  await expect.poll(preferred).toEqual([CODEX_WORK]);
  await expect(work.locator("[data-crew-preferred]")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("[data-crew-preferred]")).toHaveCount(1);
  // Unpin to leave clean state; the setting is a switch, so its menu is still open.
  await page.locator('[data-menu-item="prefer"]').click();
  await expect.poll(preferred).toEqual([]);
  await expect(page.locator("[data-crew-preferred]")).toHaveCount(0, { timeout: 10_000 });
  await page.keyboard.press("Escape");
});

async function openModels(page: Page) {
  const models = modelsSection(page);
  const head = models.getByRole("button", { name: /^Models/ });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return models;
}

/**
 * A Codex model the board lists in no slot: the row these tests pin, place
 * and turn off. Every model Codex lists starts in a level now that GPT-6.1
 * Terra takes medium (STARTER_SLOTS), so each test takes Codex's medium
 * starter out of every level it sits in, through the call a model's panel
 * makes, and reads it back off the app's own slots view: whichever model the
 * starter map names that day.
 */
async function offCodexModel(page: Page): Promise<{ key: string; label: string }> {
  const id = starterFor("openai-codex", "medium");
  const codexRow = (view: ModelSlotsView) =>
    view.models.find((row) => row.provider === "openai-codex" && row.id === id);
  let view = await page.evaluate(() => window.infinitary.models.slots());
  const model = codexRow(view);
  if (!model) throw new Error(`Codex's medium starter ${id} is not listed`);
  const key = offeringKey(model);
  for (const level of model.slots) {
    view = await page.evaluate(
      ({ offering, slot }) => window.infinitary.models.setSlotMembership(offering, slot, false),
      { offering: key, slot: level },
    );
  }
  expect(codexRow(view)?.slots).toEqual([]);
  return { key, label: model.label };
}

test("model rows are one per offering and pins persist", async () => {
  const { page } = launched;
  // Two Codex accounts serve every Codex model, but a slot is an offering: one row.
  const { label } = await offCodexModel(page);
  const pinned = `${label} ✱`;
  const models = await openModels(page);
  await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(1);
  await page.getByLabel("Models").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("dark-settings-model-checklist.png") });
  const panel = await openModelPanel(page, levelLane(models, "off"), label);
  await alwaysUseSwitch(panel, label).click();
  await expect(page.getByRole("button", { name: pinned, exact: true })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  const reopened = await openModels(page);
  await expect(page.getByRole("button", { name: pinned, exact: true })).toBeVisible({
    timeout: 10_000,
  });
  const again = await openModelPanel(page, levelLane(reopened, "off"), label);
  await expect(alwaysUseSwitch(again, label)).toBeChecked();
  await alwaysUseSwitch(again, label).click();
  await expect(page.getByRole("button", { name: pinned, exact: true })).toHaveCount(0);
});

test("slot membership and off persist across a settings round-trip", async () => {
  const { page } = launched;
  const { key, label } = await offCodexModel(page);
  const models = await openModels(page);
  // An offering renders one pill under every level it belongs to, so a pill
  // is addressed by its level.
  const rowIn = (slot: string) =>
    page.locator(`[data-slot-group="${slot}"] [data-model-row="${key}"]`);
  const nameIn = (slot: string) => modelName(rowIn(slot), label);
  const panel = await openModelPanel(page, levelLane(models, "off"), label);
  await setLevelInPanel(panel, label, "medium", true);
  await expect(nameIn("medium")).toBeVisible();
  await expect(rowIn("off")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  const reopened = await openModels(page);
  await expect(nameIn("medium")).toBeVisible({ timeout: 10_000 });

  const again = await openModelPanel(page, levelLane(reopened, "medium"), label);
  await setLevelInPanel(again, label, "low", true);
  await expect(nameIn("low")).toBeVisible();
  await expect(nameIn("medium")).toBeVisible();

  await removeFromAllLevels(again, label);
  await expect(nameIn("off")).toBeVisible();
  await expect(rowIn("medium")).toHaveCount(0);
  await expect(rowIn("low")).toHaveCount(0);
});

test("Intelligence explains automatic model selection instead of offering a switch", async () => {
  const { page } = launched;
  await expect(page.locator('[data-setting="dynamic-routing"]')).toHaveCount(0);
  await expect(modelsSection(page).locator("[data-crew-model-choice]")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  await expect(modelsSection(page).locator("[data-crew-model-choice]")).toBeVisible();
  await expect(page.locator('[data-setting="dynamic-routing"]')).toHaveCount(0);
});
