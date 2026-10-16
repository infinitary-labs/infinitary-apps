import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  modelAddedLead,
  modelAddedNote,
  modelGoneLead,
  modelGoneNote,
} from "../../src/core/routing/modelNews";
import { CLAUDE_PROVIDER_ID, catalogEntry } from "../../src/shared/providers";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import {
  claudeDefaultStore,
  type MockClaudeClientOptions,
  seedSignedInClaudeStore,
  writeMockClaudeClient,
} from "./mockClaudeClient";
import { modelsSection } from "./modelsBoard";
import { feedLine } from "./rails";

/**
 * Lean model lists (captain, 2026-09-23; docs/model-lists.md), end to end
 * against the app's real runtime read of a Claude account's catalog - the
 * stand-in client answers the SDK's model list with the current four
 * models and eight older generations, plus what each test adds.
 *
 * The two rules under test are the captain's: nothing waits on a read, and
 * a failed read falls back to the shipped catalog silently. And the lean
 * rule itself: a family's newest generation is a row, the rest of the
 * catalog is reachable by name only, and the news is one line per new
 * generation and one per model that left - never one per catalog id.
 */

const CLAUDE_ACCOUNT = "acct_claude_lean";

/** The provider's name as the feed's model notes say it. */
const CLAUDE = catalogEntry(CLAUDE_PROVIDER_ID)?.name ?? CLAUDE_PROVIDER_ID;

/** A feed line holding the product's own words, wherever they fall in it. */
const holding = (words: string) => new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

type Row = { value: string; displayName: string };

const CLAUDE_CURRENT: Row[] = [
  { value: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", displayName: "Haiku 5.5" },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
  { value: "claude-opus-5", displayName: "Opus 5" },
  { value: "claude-fable-5", displayName: "Fable 5" },
  { value: "claude-opus-4-8", displayName: "Opus 4.8" },
  { value: "claude-opus-4-7", displayName: "Opus 4.7" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6" },
  { value: "claude-sonnet-5", displayName: "Sonnet 5" },
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
];

/** A future generation that the shipped list has not named yet. */
const WITH_SONNET_5_6: Row[] = [
  { value: "claude-sonnet-5-6", displayName: "Sonnet 5.6" },
  ...CLAUDE_CURRENT,
];

function seedClaudeAccount(userDataDir: string, enabled = true): void {
  const accountsDir = join(userDataDir, "accounts");
  // Vault bookkeeping only; the login lives in HOME/.claude (CD-1=B).
  mkdirSync(join(accountsDir, "anthropic-claude", CLAUDE_ACCOUNT), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: CLAUDE_ACCOUNT,
          providerId: "anthropic-claude",
          kind: "subscription_oauth",
          label: "Personal Max",
          enabled,
          createdAt: Date.parse("2026-08-03T00:00:00Z"),
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
}

async function openModels(page: Page) {
  if ((await page.getByRole("tab", { name: "Intelligence" }).count()) === 0) {
    await page.getByRole("button", { name: "Settings" }).click();
  }
  await page.getByRole("tab", { name: "Intelligence" }).click();
  const models = modelsSection(page);
  await expect(models).toBeVisible({ timeout: 20_000 });
  const head = models.getByRole("button", { name: /^Models/ });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return models;
}

/** The Claude rows on the board, by offering key. */
async function claudeRows(page: Page): Promise<string[]> {
  const keys = await page
    .locator("[data-model-row^='anthropic-claude/']")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model-row") ?? ""));
  return [...new Set(keys)].sort();
}

function claudeLaunch(userDataDir: string, options: MockClaudeClientOptions) {
  return launchApp({
    withMockProvider: true,
    userDataDir,
    prepareHome: (homeDir) => seedSignedInClaudeStore(claudeDefaultStore(homeDir)),
    env: {
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "claude-stub"), options),
    },
  });
}

test("a catalog read that never answers holds nothing up: the shipped list serves", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedClaudeAccount(userDataDir);
  const listing = join(userDataDir, "claude-listing.json");
  writeFileSync(listing, JSON.stringify(CLAUDE_CURRENT));
  const app = await claudeLaunch(userDataDir, {
    listModelsFile: listing,
    listModelsHangMs: 10 * 60_000,
  });
  try {
    // The pool answers from the shipped catalog while the read is out: the
    // read hangs for ten minutes, far past this test's own time, so an
    // answer at all is an answer that did not wait for it.
    const available = await app.page.evaluate(() => window.infinitary.models.available());
    expect(available).toContainEqual({ provider: "anthropic-claude", id: "claude-sonnet-5-5" });
    expect(available).not.toContainEqual({ provider: "anthropic-claude", id: "claude-sonnet-5" });

    const models = await openModels(app.page);
    await expect(
      models
        .locator('[data-slot-group="medium"]')
        .getByRole("button", { name: "Claude Sonnet 5.5", exact: true }),
    ).toBeVisible();
    // The shipped list names only the current generations.
    expect(await claudeRows(app.page)).toEqual([
      "anthropic-claude/claude-fable-5-1",
      "anthropic-claude/claude-haiku-5-5",
      "anthropic-claude/claude-opus-5-5",
      "anthropic-claude/claude-sonnet-5-5",
    ]);
  } finally {
    await app.close();
  }
});

test("a Claude account read at runtime: the newest generations, a kept model that left, and a failed read", async () => {
  // One account across three launches: each step reads what the one before
  // it left in the account's catalog and slots. Each launch keeps the minute
  // it had as a test of its own.
  test.setTimeout(3 * 60_000);
  const userDataDir = scratchDir("infinitary-e2e-");
  const listing = join(userDataDir, "claude-listing.json");
  seedClaudeAccount(userDataDir);

  await test.step("lists each family's newest generation, says so once, and leaves the rest by name", async () => {
    writeFileSync(listing, JSON.stringify(WITH_SONNET_5_6));
    const app = await claudeLaunch(userDataDir, { listModelsFile: listing });
    try {
      // One line for the new generation once the read lands, and none for
      // the eight older ones.
      await expect(feedLine(app.page, modelAddedNote(CLAUDE, "claude-sonnet-5-6", []))).toBeVisible(
        { timeout: 25_000 },
      );
      await expect(feedLine(app.page, holding(modelAddedLead(CLAUDE)))).toHaveCount(1);

      const models = await openModels(app.page);
      // The new generation is a row, off.
      await expect(
        models
          .locator('[data-slot-group="off"]')
          .getByRole("button", { name: "Claude Sonnet 5.6", exact: true }),
      ).toBeVisible({ timeout: 25_000 });
      // Five rows for thirteen served ids: each family's newest, plus the
      // Sonnet 5.5 starter it has not replaced yet.
      expect(await claudeRows(app.page)).toEqual([
        "anthropic-claude/claude-fable-5-1",
        "anthropic-claude/claude-haiku-5-5",
        "anthropic-claude/claude-opus-5-5",
        "anthropic-claude/claude-sonnet-5-5",
        "anthropic-claude/claude-sonnet-5-6",
      ]);

      // An older generation is reachable by name from a slot's picker, and
      // choosing it keeps it listed.
      const low = models.locator('[data-slot-group="low"]');
      await low.getByRole("button", { name: "Add model" }).click();
      const picker = low.getByRole("group", { name: "Add a model to low" });
      await picker.getByRole("textbox", { name: "Find a model to add to low" }).fill("opus 4.8");
      await picker.getByRole("button", { name: "Add Claude Opus 4.8 to low" }).click();
      await expect(low.getByRole("button", { name: "Claude Opus 4.8", exact: true })).toBeVisible();
      expect(await claudeRows(app.page)).toContain("anthropic-claude/claude-opus-4-8");

      await app.page.screenshot({ path: test.info().outputPath("dark-models-lean-claude.png") });
    } finally {
      await app.close();
    }
  });

  await test.step("announces once a kept model a later successful read no longer serves", async () => {
    // Claude drops Opus 4.8 between launches; the person had kept it in low.
    writeFileSync(
      listing,
      JSON.stringify(WITH_SONNET_5_6.filter((row) => row.value !== "claude-opus-4-8")),
    );
    const app = await claudeLaunch(userDataDir, { listModelsFile: listing });
    try {
      // A model the account no longer serves has no label left to read,
      // so the line names it by id, as the arrival line does.
      await expect(
        feedLine(app.page, modelGoneNote(CLAUDE, "claude-opus-4-8", ["low"])),
      ).toBeVisible({ timeout: 25_000 });
      await expect(feedLine(app.page, holding(modelGoneLead(CLAUDE)))).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  await test.step("a failed read falls back to the shipped list and says nothing", async () => {
    writeFileSync(listing, "Authentication required\n");
    const app = await claudeLaunch(userDataDir, { listModelsFile: listing });
    try {
      // A failure is not evidence a model left: no line about Sonnet 5.6,
      // once the read has had time to fail.
      await app.page.waitForTimeout(5_000);
      await expect(
        feedLine(app.page, modelGoneNote(CLAUDE, "claude-opus-4-8", ["low"])),
      ).toBeVisible();
      await expect(
        feedLine(app.page, holding(`${modelGoneLead(CLAUDE)}claude-sonnet-5-6`)),
      ).toHaveCount(0);

      const models = await openModels(app.page);
      // Shipped: Sonnet 5.6 is not in it, so its row goes; the current
      // four serve on.
      await expect(
        models.getByRole("button", { name: "Claude Sonnet 5.6", exact: true }),
      ).toHaveCount(0, { timeout: 25_000 });
      await expect(
        models
          .locator('[data-slot-group="medium"]')
          .getByRole("button", { name: "Claude Sonnet 5.5", exact: true }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

test("an older successful catalog cannot remove the runnable Haiku low starter", async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedClaudeAccount(userDataDir, false);
  const listing = join(userDataDir, "claude-listing.json");
  writeFileSync(
    listing,
    JSON.stringify(CLAUDE_CURRENT.filter((row) => row.value !== "claude-haiku-5-5")),
  );
  const app = await claudeLaunch(userDataDir, { listModelsFile: listing, version: "2.1.290" });
  try {
    // A successful metadata response is not an exhaustive catalog on this client.
    // The fallback remains available for routing.
    const log: string[] = [];
    app.app.process().stderr?.on("data", (chunk) => log.push(String(chunk)));
    await app.page.evaluate(
      (id) => window.infinitary.accounts.setEnabled(id, true),
      CLAUDE_ACCOUNT,
    );
    await expect.poll(() => log.join("")).toContain("client catalog predates Haiku 5.5");
    expect(await app.page.evaluate(() => window.infinitary.models.available())).toContainEqual({
      provider: "anthropic-claude",
      id: "claude-haiku-5-5",
    });
  } finally {
    await app.close();
  }
});
