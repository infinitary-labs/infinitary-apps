import { expect, type Page, test } from "@playwright/test";
import { NO_READER_TEXT, noReaderText } from "../../src/renderer/src/settings/subscriptionsWords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountRoot } from "./accountFixtures";
import { type LaunchedApp, launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { seedQuotaFixture } from "./quotaFixtures";
import { setThemeViaSettings } from "./theme";

/**
 * Newly connected sensed accounts must not claim Infinitary "doesn't read the
 * allowance" while the first sensor pass is still outstanding. That sentence
 * is reserved for genuinely unsensed providers (OpenRouter). Reproduction:
 * connect Grok against an empty quota fixture so the row lands before any
 * snapshot row for it exists - on main that showed the no-reader sentence
 * until the 300s tick; with the fix it is pending "reading…".
 */

// Made per launch, never at module load: Playwright's runner loads this file
// too, and a directory made there outlives every worker's cleanup.
const clients = () => ({
  INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
});

function emptyQuotaFixture(): string {
  return seedQuotaFixture(scratchDir("infinitary-quota-empty-"), {
    generatedAt: new Date().toISOString(),
    fetchedAt: Date.now(),
    providers: [],
  });
}

async function openIntelligence(app: LaunchedApp) {
  await app.page.getByRole("button", { name: "Settings", exact: true }).click();
  await app.page.getByRole("tab", { name: "Intelligence" }).click();
  await expect(app.page.locator("[data-subscriptions]")).toBeVisible({ timeout: 15_000 });
}

/** The foot's key prompt sits flush (no data-connect-aside frame). */
async function submitApiKey(page: Page, prompt: RegExp, key: string) {
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 20_000 });
  const box = page.getByText(prompt).locator("..").getByRole("textbox");
  await box.fill(key);
  await page.getByRole("button", { name: "Submit" }).click();
}

async function connectGrokByApiKey(app: LaunchedApp) {
  await app.page.getByRole("button", { name: "Connect Grok" }).click();
  const choice = app.page.locator("[data-connect-method]");
  await expect(choice).toBeVisible({ timeout: 10_000 });
  await choice.getByRole("button", { name: "API key" }).click();
  await submitApiKey(app.page, /Enter xAI API key/i, "xai-pending-e2e-key");
}

test("a newly connected sensed account shows reading…, never the no-reader sentence", async () => {
  const fixtureDir = emptyQuotaFixture();
  const userDataDir = scratchDir("infinitary-e2e-");
  seedAccountRoot(userDataDir);
  const app = await launchApp({
    userDataDir,
    env: { ...clients(), INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir },
  });
  try {
    await openIntelligence(app);
    await connectGrokByApiKey(app);

    const row = app.page.locator("[data-account-row]").filter({ hasText: "Grok" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Dismiss the invite-to-rename so the row reads as a normal account.
    const cancel = row.getByRole("button", { name: "Cancel" });
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click();
    }
    await expect(row).toHaveAttribute("data-row-kind", "pending", { timeout: 10_000 });
    await expect(row.getByText("reading…")).toBeVisible();
    await expect(row.getByText(NO_READER_TEXT)).toHaveCount(0);
    await expect(row.getByRole("img", { name: /reading…$/ })).toBeVisible();

    // Dark + light screenshots of the pending row (PR assets).
    await row.screenshot({
      path: test.info().outputPath("dark-allowance-pending-on-connect.png"),
    });
    // The theme lives in Settings -> General since the main-view control
    // went (#289); Settings stays open for the light screenshot.
    await setThemeViaSettings(app.page, "light", { close: false });
    await app.page.getByRole("tab", { name: "Intelligence" }).click();
    const lightRow = app.page.locator("[data-account-row]").filter({ hasText: "Grok" });
    await expect(lightRow.getByText("reading…")).toBeVisible({ timeout: 10_000 });
    await lightRow.screenshot({
      path: test.info().outputPath("light-allowance-pending-on-connect.png"),
    });
  } finally {
    await app.close();
  }
});

test("OpenRouter still uses the no-reader sentence (unsensed lock)", async () => {
  const fixtureDir = emptyQuotaFixture();
  const userDataDir = scratchDir("infinitary-e2e-");
  const app = await launchApp({
    userDataDir,
    env: { ...clients(), INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir },
  });
  try {
    await openIntelligence(app);
    await app.page.getByRole("button", { name: "Connect OpenRouter" }).click();
    const choice = app.page.locator("[data-connect-method]");
    // OpenRouter is usually key-only; some catalogs still offer a choice.
    if (await choice.isVisible().catch(() => false)) {
      await choice.getByRole("button", { name: "API key" }).click();
    }
    await submitApiKey(app.page, /Enter OpenRouter API key/i, "or-pending-e2e-key");

    const row = app.page.locator("[data-account-row]").filter({ hasText: "OpenRouter" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    const cancel = row.getByRole("button", { name: "Cancel" });
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click();
    }
    await expect(row).toHaveAttribute("data-row-kind", "no_row");
    await expect(row.getByText(noReaderText("api_key"))).toBeVisible();
    await expect(row.getByText("reading…")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
