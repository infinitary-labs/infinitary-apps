import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { GATED_CHECK_PLACEHOLDER } from "@shared/firstRun";
import type { Slot } from "@shared/modelSlots";
import { freshCheckTitle } from "../../src/renderer/src/app/firstRunGateWords";
import { INTEGRATIONS_MCP_WORDS, integrationRenameWords } from "../../src/shared/integrations";
import { SAMPLE_NOTES, serveNotesHttp } from "../helpers/mcpStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { startCustomApiFixture } from "./customApiFixture";
import { STUB_LOGIN, startGitHubStub } from "./githubStub";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER, startMockProvider } from "./mockProvider";
import {
  closeModelPanel,
  levelLane,
  openModelPanel,
  openModelsBoard,
  setLevelInPanel,
} from "./modelsBoard";
import { asSavedByOlderRelease, seedLegacyGithubServer } from "./olderProfile";
import { promptInput } from "./prompt";
import {
  GITHUB_NAMES_PROMPT,
  GITHUB_NAMES_REPORT,
  GITHUB_SERVER_NAME,
  githubNames,
} from "./scenarios/githubNames";
import { settingsSection } from "./settings";
import { closeOpenCards } from "./stack";
import { pressKey, runFromSearch, typeInto } from "./windowKeys";

// A profile an older release saved, opened in this build: the upgrade a
// person makes (docs/saved-data-compatibility.md, "Profiles saved by an older
// release"). Each journey sets the profile up on this build, quits, rewrites
// it into the older release's form, and opens it again.

const FIRSTMATE_MODEL = "operator-model";
const CREW_MODEL = "operator-large-model";

let launched: LaunchedApp | undefined;
let api: Awaited<ReturnType<typeof startCustomApiFixture>> | undefined;
let model: Awaited<ReturnType<typeof startMockProvider>> | undefined;
test.afterEach(async () => {
  if (launched)
    writeFileSync(
      test.info().outputPath("diagnostic-state.json"),
      JSON.stringify(
        await launched.page.evaluate(async () => ({
          firstRun: await window.infinitary.app.firstRun(),
          firstmateModel: await window.infinitary.settings.getFirstmateModel(),
          available: await window.infinitary.models.available(),
          slots: await window.infinitary.models.slots(),
          custom: await window.infinitary.accounts.custom.list(),
        })),
        null,
        2,
      ),
    );
  await launched?.close();
  await api?.close();
  await model?.close();
  launched = undefined;
  api = undefined;
  model = undefined;
});

/** The crew slots a model holds, none while it is not offered. */
function placements(page: Page, provider: string, id: string): Promise<Slot[]> {
  return page.evaluate(
    async ({ provider, id }) => {
      const view = await window.infinitary.models.slots();
      return (
        [...view.models, ...view.byName].find((row) => row.provider === provider && row.id === id)
          ?.slots ?? []
      );
    },
    { provider, id },
  );
}

/** The models of one connection that work can run on. */
async function offered(page: Page, provider: string): Promise<string[]> {
  const models = await page.evaluate(() => window.infinitary.models.available());
  return models.filter((entry) => entry.provider === provider).map((entry) => entry.id);
}

async function gateOpen(page: Page): Promise<boolean> {
  return (await page.evaluate(() => window.infinitary.app.firstRun())).gateOpen;
}

/**
 * A connection to the custom API fixture and nothing else, set up through the
 * calls Settings makes: both models checked and saved, the Firstmate on one,
 * a crew slot on each.
 */
async function connectCustomOnly(
  page: Page,
  baseUrl: string,
  protocol: "openai-completions" | "openai-responses",
): Promise<{ id: string; providerId: string }> {
  const saved = await page.evaluate(
    async ({ baseUrl, protocol, models }) => {
      const custom = window.infinitary.accounts.custom;
      const { destination } = await custom.review(baseUrl, "local");
      const draft = await custom.prepare({
        label: "Operator gateway",
        baseUrl,
        mode: "local",
        protocol,
        key: "",
        noKey: true,
        headers: [],
        approvedDestination: destination,
        unencryptedLocalApproved: true,
        allowStorageDefault: false,
        storageApproved: false,
        models: models.map((id) => ({ id, context: 200000, output: 4096 })),
      });
      if (!draft.draftId) throw new Error("No draft to check");
      for (const id of models) await custom.check(draft.draftId, id);
      return custom.save(draft.draftId, false);
    },
    { baseUrl, protocol, models: [FIRSTMATE_MODEL, CREW_MODEL] },
  );
  const account = (await page.evaluate(() => window.infinitary.accounts.list())).find(
    (entry) => entry.id === saved.accountId,
  );
  if (!account) throw new Error("The custom connection was not saved");
  const { providerId } = account;
  await expect
    .poll(() => offered(page, providerId))
    .toEqual(expect.arrayContaining([FIRSTMATE_MODEL, CREW_MODEL]));
  for (const [id, slot] of [
    [FIRSTMATE_MODEL, "medium"],
    [CREW_MODEL, "high"],
  ] as const)
    await page.evaluate(
      ({ key, slot }) => window.infinitary.models.setSlotMembership(key, slot, true),
      { key: `${providerId}/${id}`, slot },
    );
  await page.evaluate((model) => window.infinitary.settings.setFirstmateModel(model), {
    provider: providerId,
    id: FIRSTMATE_MODEL,
  });
  // The window re-reads the gate on a quota push; a model choice pushes none.
  await page.evaluate(() => window.infinitary.quota.refresh());
  return { id: account.id, providerId };
}

/**
 * The first-launch gate's ask for a connection's fresh check, and its one
 * action (`FirstRunGate`): the gate names the connection instead of asking
 * for a subscription.
 */
function freshCheckAsk(page: Page, accountId: string) {
  const gate = page.locator('[data-first-run-gate="open"]');
  return {
    gate,
    title: gate.locator("[data-gate-title]"),
    ask: gate.locator(`[data-fresh-check="${accountId}"]`),
    action: gate.locator(`[data-fresh-check="${accountId}"] button`),
    failure: gate.getByRole("alert"),
  };
}

for (const protocol of ["openai-completions", "openai-responses"] as const) {
  test(`${protocol}: a custom-API-only profile an older release saved works after the upgrade`, async () => {
    const provider = await startMockProvider();
    model = provider;
    const server = await startCustomApiFixture(provider.port);
    api = server;
    const options = {
      reuseMockProvider: provider,
      modelsJson: () => JSON.stringify({ providers: {} }),
    };
    let app = await launchApp(options);
    launched = app;
    let page = app.page;
    const account = await test.step("set up: only a custom connection, in use", async () => {
      const connected = await connectCustomOnly(page, server.baseUrl, protocol);
      await expect.poll(() => gateOpen(page)).toBe(false);
      await askFirstmate(page, "Please pause the work for now");
      return connected;
    });

    await test.step("upgrade: the profile, as the release before saved it, opens here", async () => {
      await app.close();
      launched = undefined;
      // Something was rewritten, or the journey would open this build's own profile.
      expect(asSavedByOlderRelease(app.userDataDir).customChecks).not.toHaveLength(0);
      app = await launchApp({ ...options, userDataDir: app.userDataDir, homeDir: app.homeDir });
      launched = app;
      page = app.page;
      // Right after the upgrade the gate names the connection the Firstmate
      // was chosen on and asks for its fresh check in place, never for a
      // subscription.
      const [connection] = await page.evaluate(() => window.infinitary.accounts.custom.list());
      const label = connection?.label ?? "";
      const fresh = (await page.evaluate(() => window.infinitary.app.firstRun())).freshCheck;
      expect(fresh?.accountId).toBe(account.id);
      expect(fresh?.models).toEqual(expect.arrayContaining([FIRSTMATE_MODEL, CREW_MODEL]));
      // A card on the stage covers the gate; the welcome the setup earned
      // may still be up.
      await closeOpenCards(page);
      const { title, ask } = freshCheckAsk(page, account.id);
      await expect(ask).toBeVisible();
      await expect(title).toHaveText(freshCheckTitle(label));
      await expect(promptInput(page)).toHaveAttribute("placeholder", GATED_CHECK_PLACEHOLDER);
      await page.screenshot({ path: test.info().outputPath(`${protocol}-upgraded.png`) });
    });

    await test.step("one fresh check, from the gate: Firstmate's model and the crew's are offered again", async () => {
      const { action, failure } = freshCheckAsk(page, account.id);
      // A server that refuses keeps the ask, with its reason beside it.
      server.refuse(503);
      await pressKey(action, "Enter");
      await expect(failure).toBeVisible();
      expect(await gateOpen(page)).toBe(true);
      server.refuse(200);
      await pressKey(action, "Enter");
      await expect.poll(() => gateOpen(page)).toBe(false);
      await expect(page.locator('[data-first-run-gate="open"]')).toHaveCount(0);
      expect(await offered(page, account.providerId)).toEqual(
        expect.arrayContaining([FIRSTMATE_MODEL, CREW_MODEL]),
      );
      // The crew slots chosen before the upgrade come back with the models.
      expect(await placements(page, account.providerId, FIRSTMATE_MODEL)).toContain("medium");
      expect(await placements(page, account.providerId, CREW_MODEL)).toContain("high");
    });

    await test.step("crew use takes a click on the Models board", async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Intelligence" }).click();
      const models = await openModelsBoard(page);
      const panel = await openModelPanel(page, levelLane(models, "high"), CREW_MODEL);
      await setLevelInPanel(panel, CREW_MODEL, "low", true);
      await closeModelPanel(models);
      await expect.poll(() => placements(page, account.providerId, CREW_MODEL)).toContain("low");
      await page.screenshot({ path: test.info().outputPath(`${protocol}-crew.png`) });
    });

    await test.step("Firstmate answers", async () => {
      await page.keyboard.press("Escape");
      await askFirstmate(page, "Resume the work please");
      await page.screenshot({ path: test.info().outputPath(`${protocol}-answered.png`) });
    });
  });
}

/**
 * INF-882, captain's automatic-name choice: preserve GitHub sign-in and explain the server's new name.
 * Promised result: an older server named GitHub gets a distinct name, the name is reserved while signed
 * out, sign-in still completes, and the crew's reads by both names reach the right connections.
 * Data: the real MCP binding's discovery from the notes stand-in and GitHub's device-flow stand-in.
 * Completion: Settings and its explanation survive restart, project discovery works, and a real crew
 * command reports GitHub's account and the server's notes. No outward write is made.
 * Prerequisites: the hermetic launcher. Shared resources: none; folders, servers and ports are private.
 */
test("GitHub sign-in keeps distinct integration names and the crew reaches both", async () => {
  const userDataDir = scratchDir("infinitary-integration-names-");
  const notes = await serveNotesHttp("modern");
  const github = await startGitHubStub();
  let launched: LaunchedApp | undefined;
  try {
    await seedLegacyGithubServer(userDataDir, notes.url);
    launched = await launchApp({
      withMockProvider: true,
      scenarios: [githubNames],
      userDataDir,
      env: github.env,
    });
    let { app, page } = launched;
    await runFromSearch(app, page, "settings.integrations");
    let tab = settingsSection(page, "integrations");
    const explanation = integrationRenameWords({ from: "GitHub", for: "GitHub" });
    await expect(tab.locator('[data-integration-row="mcp-github"]')).toContainText(
      GITHUB_SERVER_NAME,
    );
    await expect(tab.locator('[data-integration-renamed="mcp-github"]')).toHaveText(explanation);
    // A new server cannot reclaim GitHub, even before the person signs in.
    await pressKey(tab.locator('[data-integration-add="mcp"] button'), "Enter");
    const form = tab.locator("[data-integration-mcp-form]");
    const name = form.getByLabel(INTEGRATIONS_MCP_WORDS.name);
    await typeInto(name, "GitHub");
    await pressKey(name, "Tab");
    const runs = form.getByLabel(INTEGRATIONS_MCP_WORDS.runs);
    await typeInto(runs, notes.url, { insert: true });
    await pressKey(runs, "Enter");
    await expect(form.getByRole("status")).toBeVisible();
    await expect(form.getByRole("status")).toContainText("GitHub");
    expect(
      (await page.evaluate(() => window.infinitary.integrations.list())).integrations,
    ).toHaveLength(1);
    await pressKey(form.getByRole("button", { name: INTEGRATIONS_MCP_WORDS.cancel }), "Enter");
    // The same GitHub device flow still serves project work.
    await pressKey(tab.locator('[data-integration-add="github"] button'), "Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.forges.list())).flow?.host)
      .toBe("github.com");
    github.device.approve();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.integrations.list())).integrations.map(
          (row) => [row.name, row.account],
        ),
      )
      .toEqual([
        ["GitHub", STUB_LOGIN],
        [GITHUB_SERVER_NAME, null],
      ]);
    await expect(tab.locator('[data-integration-row="github"]')).toContainText(`as ${STUB_LOGIN}`);
    await page.evaluate(() => window.infinitary.forges.projects("github.com"));
    expect(github.requests()).toContain("GET /user/repos");
    await launched.close();
    launched = await launchApp({
      withMockProvider: true,
      scenarios: [githubNames],
      userDataDir,
      env: github.env,
    });
    ({ app, page } = launched);
    await runFromSearch(app, page, "settings.integrations");
    tab = settingsSection(page, "integrations");
    await expect(tab.locator('[data-integration-row="mcp-github"]')).toContainText(
      GITHUB_SERVER_NAME,
    );
    await expect(tab.locator('[data-integration-renamed="mcp-github"]')).toHaveText(explanation);
    await page.keyboard.press("Escape");
    const title = GITHUB_NAMES_PROMPT;
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    const outcome = () =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? ((await window.infinitary.tasks.detail(row.id))?.outcome ?? "") : "";
      }, title);
    await expect.poll(outcome, { timeout: 60_000 }).toContain(GITHUB_NAMES_REPORT);
    const report = await outcome();
    expect(report).toContain(STUB_LOGIN);
    expect(report).toContain(GITHUB_SERVER_NAME);
    for (const note of SAMPLE_NOTES) expect(report).toContain(note);
    await test
      .info()
      .attach("integration-read-answers", { body: report, contentType: "text/plain" });
    console.log(`Integration read answers from the stand-ins:\n${report}`);
  } finally {
    await launched?.close();
    await github.close();
    await notes.close();
  }
});
