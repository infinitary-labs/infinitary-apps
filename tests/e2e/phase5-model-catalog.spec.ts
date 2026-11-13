import { expect, type Page, test } from "@playwright/test";
import {
  ALWAYS_USE_LEAD,
  dropPlan,
  removeAllLine,
  usedLine,
} from "../../src/renderer/src/settings/levelDrops";
import { levelList } from "../../src/shared/levelWords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { expectClaudeConnected, launchSignedInClaude } from "./claudeAccount";
import type { LaunchedApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import {
  alwaysUseSwitch,
  closeModelPanel,
  dragModel,
  type Level,
  levelLane,
  modelName,
  modelPill,
  modelsSection,
  openModelPanel,
  removeFromAllLevels,
  removeFromLevel,
  setLevelInPanel,
} from "./modelsBoard";
import { claudeStarter } from "./starters";
import { setThemeViaSettings } from "./theme";
import { pressKey } from "./windowKeys";

/**
 * The Subscriptions "Models" section, run against the REAL catalog path -
 * no INFINITARY_QUOTA_FIXTURE_DIR. That fixture substitutes a hand-authored
 * two-model catalog for the whole fetcher, which is exactly why the section
 * could list providers the user had never signed in to without any test
 * noticing: piAuth.catalogModels() and buildModelsCatalog() never ran e2e.
 *
 * Here they do. Claude is signed in through its stand-in client and Grok
 * with a key; a second Grok account is switched off; Codex was never
 * connected at all. Only the signed-in subscriptions may appear.
 *
 * Nothing in this test reaches the provider: Claude's isolated store has a
 * dummy credential file for the real health read, and its allowance read
 * goes to the unused loopback port named below. The Grok key's allowance
 * read goes to the local port launch.ts names (`INFINITARY_GROK_KEY_URL`).
 * The model catalog comes from the stand-in Claude client and pi-ai's
 * bundled data (launch.ts sets PI_OFFLINE).
 */

const GROK_DISABLED = "acct_grok_off";
const GROK_PERSONAL = "acct_grok1";
const CLAUDE_PERSONAL = "acct_claude1";

function seedAccounts(userDataDir: string): void {
  seedAccountStore(userDataDir, "xai", GROK_DISABLED, { recursive: true, mode: 0o700 });
  seedAccountAuth(
    userDataDir,
    "xai",
    GROK_DISABLED,
    { xai: { type: "api_key", key: "x" } },
    {
      mode: 0o600,
    },
  );

  seedAccountStore(userDataDir, "xai", GROK_PERSONAL, { recursive: true, mode: 0o700 });
  seedAccountAuth(
    userDataDir,
    "xai",
    GROK_PERSONAL,
    { xai: { type: "api_key", key: "y" } },
    { mode: 0o600 },
  );
  seedAccountStore(userDataDir, "anthropic-claude", CLAUDE_PERSONAL, {
    recursive: true,
    mode: 0o700,
  });
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: GROK_DISABLED,
        providerId: "xai",
        kind: "api_key",
        label: "Old key",
        // Signed in, but switched off: it leaves the selection pool, so it
        // leaves this section too.
        enabled: false,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
      {
        id: CLAUDE_PERSONAL,
        providerId: "anthropic-claude",
        kind: "subscription_oauth",
        label: "Personal Max",
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
    ],
    {},
    { mode: 0o600 },
  );
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  const userDataDir = scratchDir("infinitary-e2e-");
  seedAccounts(userDataDir);
  launched = await launchSignedInClaude(CLAUDE_PERSONAL, {
    withMockProvider: true,
    userDataDir,
    env: {
      // Dummy credentials never reach the provider's allowance endpoint.
      INFINITARY_CLAUDE_USAGE_URL: "http://127.0.0.1:9/usage",
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
    },
  });
  await expectClaudeConnected(launched.page, CLAUDE_PERSONAL);
  await launched.page.getByRole("button", { name: "Settings" }).click();
  await launched.page.getByRole("tab", { name: "Intelligence" }).click();
});

test.afterAll(async () => {
  await launched.close();
});

/** What a level says a drop will do before it happens, in the board's own words. */
function dropHint(
  slots: Level[],
  from: Level | "off",
  to: Level | "off",
  keepBoth = false,
): string {
  const plan = dropPlan({ slots }, from, to, keepBoth);
  if (!plan) throw new Error(`A drop from ${from} on ${to} does nothing`);
  return plan.label;
}

/** Ensure the Models disclosure is open. */
async function openModels(page: Page) {
  const models = modelsSection(page);
  await expect(models).toBeVisible({ timeout: 20_000 });
  const head = models.getByRole("button", { name: /^Models/ });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return models;
}

test("the models section offers the connected subscriptions' models only", async () => {
  const { page } = launched;
  const models = await openModels(page);
  // The rows a person can place or pin come from what is signed in and
  // switched on - Claude and the enabled Grok key each bring rows from the
  // real catalog.
  const rows = models.locator("[data-model-row]");
  await expect(rows.first()).toBeVisible();
  const providers = new Set(
    (
      await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-model-row")))
    ).map((key) => key?.split("/")[0]),
  );
  expect(providers).toContain("anthropic-claude");
  expect(providers).toContain("xai");
  // Codex and OpenRouter were never connected: the provider-wide catalog
  // behind the section still carries them, the section does not.
  expect(providers).not.toContain("openai-codex");
  expect(providers).not.toContain("openrouter");
  // The paused Grok account keeps its own row in the list above.
  await expect(page.locator(`[data-account-row="${GROK_DISABLED}"]`)).toHaveAttribute(
    "data-paused",
    "true",
  );
});

test("an off catalog model can be added directly to a routing bucket", async () => {
  const { page } = launched;
  const models = await openModels(page);
  const high = models.locator('[data-slot-group="high"]');
  const low = models.locator('[data-slot-group="low"]');
  const off = () => models.locator('[data-slot-group="off"]');

  // Take Haiku out of low first: it was in no other level, so it lands in Not in use.
  await removeFromLevel(low, claudeStarter("low").name, "low");
  await expect(
    off().getByRole("button", { name: claudeStarter("low").name, exact: true }),
  ).toBeVisible();

  await high.getByRole("button", { name: "Add model" }).click();
  await expect(
    high.getByRole("group", { name: `Add a model to ${levelList(["high"])}` }),
  ).toBeVisible();
  await high
    .getByRole("button", { name: `Add ${claudeStarter("low").name} to ${levelList(["high"])}` })
    .click();

  await expect(modelName(high, claudeStarter("low").name)).toBeVisible();
  await expect(
    off().getByRole("button", { name: claudeStarter("low").name, exact: true }),
  ).toHaveCount(0);
});

test("a connected provider's models are pinnable from the section", async () => {
  const { page } = launched;
  const opus = claudeStarter("high").name;
  const models = await openModels(page);
  // Always use is the model's own setting, so it lives in the panel its name opens.
  const panel = await openModelPanel(page, models, opus);
  const banner = models.locator("[data-models-banner]");
  await expect(banner).toHaveCount(0);
  await alwaysUseSwitch(panel, opus).click();
  await expect(modelName(models, opus, true).first()).toBeVisible();
  // The board says out loud what that does to every level.
  await expect(banner).toContainText(`${ALWAYS_USE_LEAD} ${opus}`);
  await alwaysUseSwitch(panel, opus).click();
  await expect(modelName(models, opus, true)).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await closeModelPanel(models);
});

test("a model already in a bucket can be added to another from the catalog, and stays in both", async () => {
  const { page } = launched;
  const opus = claudeStarter("high").name;
  const models = await openModels(page);
  const premium = models.locator('[data-slot-group="premium"]');
  const high = models.locator('[data-slot-group="high"]');
  const opusIn = (group: typeof premium) => modelName(group, opus);

  // The starter map puts Claude's high model in high the first time the account is
  // seen, so a picker that listed only OFF models could offer it to no
  // bucket at all - premium least of all. Every Claude model on a signed-in
  // account is placed that way, which is what made the board look like it
  // refused Claude entirely. An offering may sit in more than one slot, so
  // the picker offers every model not already in THIS bucket and says where
  // each one sits now.
  await expect(opusIn(high)).toBeVisible();
  await premium.getByRole("button", { name: "Add model" }).click();
  const picker = premium.getByRole("group", { name: `Add a model to ${levelList(["premium"])}` });
  await expect(picker).toBeVisible();
  const offer = picker.getByRole("button", { name: `Add ${opus} to ${levelList(["premium"])}` });
  await expect(offer).toContainText(levelList(["high"]));
  await offer.click();

  // In both now: premium gained a row and high kept its own.
  await expect(opusIn(premium)).toBeVisible();
  await expect(opusIn(high)).toBeVisible();
  // The pick closes the picker; reopened, it no longer offers what is here.
  await expect(picker).toHaveCount(0);
  await premium.getByRole("button", { name: "Add model" }).click();
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("button", { name: `Add ${opus} to ${levelList(["premium"])}` }),
  ).toHaveCount(0);
  await premium.getByRole("button", { name: "Add model" }).click();
  await expect(picker).toHaveCount(0);

  // Leaving one bucket leaves the other alone.
  await removeFromLevel(premium, opus, "premium");
  await expect(opusIn(premium)).toHaveCount(0);
  await expect(opusIn(high)).toBeVisible();
});

/** A listed model that sits in exactly one level, and a level it is not in, read off the app. */
async function modelInOneLevel(page: Page) {
  const view = await page.evaluate(() => window.infinitary.models.slots());
  const model = view.models.find((row) => row.slots.length === 1);
  if (!model) throw new Error("No listed model sits in exactly one level");
  const from = model.slots[0] as Level;
  const others = (["high", "medium", "low"] as const).filter((level) => level !== from);
  return {
    key: `${model.provider}/${model.id}`,
    label: model.label,
    from,
    to: others[0] as Level,
    spare: others[1] as Level,
  };
}

test("a model's panel appears only when its name is clicked, and changes the model as a whole", async () => {
  const { page } = launched;
  const models = await openModels(page);
  const { key, label, from, to } = await modelInOneLevel(page);

  // No panel until someone asks for one model.
  await closeModelPanel(models);
  await expect(models.getByRole("complementary")).toHaveCount(0);
  const panel = await openModelPanel(page, levelLane(models, from), label);
  await expect(panel).toContainText(usedLine({ slots: [from] }));

  // A second level from the panel is a second membership, not a move.
  await setLevelInPanel(panel, label, to, true);
  await expect(modelPill(models, to, key)).toBeVisible();
  await expect(modelPill(models, from, key)).toBeVisible();

  // One button takes it out of both, and names them first.
  await expect(panel).toContainText(removeAllLine({ slots: [from, to] }));
  await removeFromAllLevels(panel, label);
  await expect(modelPill(models, "off", key)).toBeVisible();
  await expect(modelPill(models, from, key)).toHaveCount(0);
  await expect(modelPill(models, to, key)).toHaveCount(0);
  await expect(panel).toContainText(usedLine({ slots: [] }));
  await page.screenshot({ path: test.info().outputPath("dark-models-panel.png") });

  // Put it back where it started and close the panel.
  await setLevelInPanel(panel, label, from, true);
  await expect(modelPill(models, from, key)).toBeVisible();
  await closeModelPanel(models);
  await expect(models.getByRole("complementary")).toHaveCount(0);
});

test("dragging a model moves it, ⌥ keeps both levels, and Not in use takes it out of every level", async () => {
  const { page } = launched;
  const models = await openModels(page);
  const { key, from, to, spare } = await modelInOneLevel(page);
  await closeModelPanel(models);
  const lane = (level: Level | "off") => levelLane(models, level);
  const hint = (level: Level | "off") => lane(level).locator("[data-drop-hint]");

  // A plain drag moves: the level says so before the drop, and the model leaves where it was.
  await dragModel(page, modelPill(models, from, key), lane(to), {
    whileOver: async () => {
      await expect(hint(to)).toHaveText(dropHint([from], from, to));
      await page.screenshot({ path: test.info().outputPath("dark-models-drag.png") });
    },
  });
  await expect(modelPill(models, to, key)).toBeVisible();
  await expect(modelPill(models, from, key)).toHaveCount(0);
  // A drag is not a click: it opens no panel.
  await expect(models.getByRole("complementary")).toHaveCount(0);

  // ⌥ at the drop keeps the level it came from too.
  await dragModel(page, modelPill(models, to, key), lane(spare), {
    keepBoth: true,
    whileOver: () => expect(hint(spare)).toHaveText(dropHint([to], to, spare, true)),
  });
  await expect(modelPill(models, spare, key)).toBeVisible();
  await expect(modelPill(models, to, key)).toBeVisible();

  // Not in use takes it out of every level, and names them before the drop.
  await dragModel(page, modelPill(models, to, key), lane("off"), {
    whileOver: () => expect(hint("off")).toHaveText(dropHint([to, spare], to, "off")),
  });
  await expect(modelPill(models, "off", key)).toBeVisible();
  await expect(modelPill(models, to, key)).toHaveCount(0);
  await expect(modelPill(models, spare, key)).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.infinitary.models.slots())).models.find(
      (model) => `${model.provider}/${model.id}` === key,
    )?.slots,
  ).toEqual([]);

  // Dragging it out of Not in use places it again, back where it started.
  await dragModel(page, modelPill(models, "off", key), lane(from), {
    whileOver: () => expect(hint(from)).toHaveText(dropHint([], "off", from)),
  });
  await expect(modelPill(models, from, key)).toBeVisible();
  await expect(modelPill(models, "off", key)).toHaveCount(0);
});

// INF-910 direction A: actual catalog names keep one muted provider in both themes.
// Real signed-in Claude/Grok catalogs; completion is computed type/color and unchanged names.
// Uses the hermetic desktop launcher only, with no shared account or device state.
test("crew chip providers use muted UI type without renaming their models", async () => {
  const { page } = launched;
  const models = await openModels(page);
  const catalog = await page.evaluate(() => window.infinitary.models.slots());
  for (const theme of ["light", "dark"] as const) {
    await setThemeViaSettings(page, theme, { close: false });
    for (const model of catalog.models) {
      const pill = modelPill(models, model.slots[0] ?? "off", `${model.provider}/${model.id}`);
      const name = pill.getByRole("button").first();
      await expect(name).toHaveAccessibleName(model.label);
      const face = await name.evaluate((button) => {
        const provider = button.firstElementChild;
        if (!provider) throw new Error("Missing provider text");
        return {
          provider: provider.textContent,
          providerColor: getComputedStyle(provider).color,
          providerFont: getComputedStyle(provider).fontFamily,
          mutedColor: getComputedStyle(button).color,
          uiFont: getComputedStyle(button).fontFamily,
        };
      });
      expect(face.provider).toBe(model.providerLabel);
      expect(face.providerColor).toBe(face.mutedColor);
      expect(face.providerFont).toBe(face.uiFont);
    }
  }
  const model = catalog.models.find(
    (row) => row.provider === "anthropic-claude" && row.slots.length > 0,
  );
  if (!model) throw new Error("No placed Claude model to open by keyboard");
  const level = model.slots[0];
  if (!level) throw new Error("The placed model has no level");
  const key = `${model.provider}/${model.id}`;
  const pill = modelPill(models, level, key);
  await pressKey(modelName(pill, model.label), "Enter");
  const panel = models.getByRole("complementary", { name: `${model.label} levels`, exact: true });
  await expect(panel).toBeVisible();
  await pressKey(panel.getByRole("button", { name: /^Close / }), "Enter");
  await expect(panel).toHaveCount(0);
  await pressKey(modelName(pill, model.label), "Tab");
  const remove = pill.getByRole("button", {
    name: `Remove ${model.label} from ${levelList([level])}`,
    exact: true,
  });
  await expect(remove).toBeFocused();
  await pressKey(remove, "Enter");
  await expect(pill).toHaveCount(0);
  const saved = await page.evaluate(() => window.infinitary.models.slots());
  expect(saved.models.find((row) => `${row.provider}/${row.id}` === key)?.slots).toEqual(
    model.slots.filter((slot) => slot !== level),
  );
  expect(saved.models.find((row) => `${row.provider}/${row.id}` === key)?.label).toBe(model.label);
});
