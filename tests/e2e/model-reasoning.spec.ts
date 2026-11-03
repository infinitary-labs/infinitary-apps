import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { expectClaudeConnected, launchSignedInClaude } from "./claudeAccount";
import { launchClaudeCrew } from "./claudeCrew";
import { resizeWindow } from "./layout";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { CLAUDE_CREW_PROMPT_MARKER } from "./mockProvider";
import { levelLane, openModelsBoard } from "./modelsBoard";
import { regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { claudeStarter } from "./starters";

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

import { reasoningLabel } from "../../src/renderer/src/settings/reasoningWords";
import { offeringKey, type SlotModelView } from "../../src/shared/modelSlots";
import { servedModelKey } from "../../src/shared/quota";
import type { LaunchedApp } from "./launch";
import { closeModelPanel, modelPill, openModelPanel, setLevelInPanel } from "./modelsBoard";
import { refuseNext } from "./settings";
import { focusOn, pressKey } from "./windowKeys";

async function open(app: LaunchedApp) {
  await resizeWindow(app.app, app.page, { width: 1280, height: 1000 });
  await app.page.getByRole("button", { name: "Settings", exact: true }).click();
  await app.page.getByRole("tab", { name: "Intelligence", exact: true }).click();
  return openModelsBoard(app.page);
}

/**
 * Opus as this launch's board names it, read once the launch's model catalog
 * carries its row. Until a launch's first allowance read builds that catalog,
 * or a catalog read rebuilds it over the saved reading, the board names a
 * model by the account's own name for it, and by the catalog's name after
 * (`ModelSlots.view`). The two agree for Opus since INF-713; before it the
 * first launch on hosted Linux named Opus "claude-opus-5-5" and the relaunch
 * "Claude Opus 5.5", so a name read before the catalog missed the boxes
 * (verify run 39474081020, INF-686). The wait is the launch's own work, for
 * as long as the test allows.
 */
async function catalogedOpus(app: LaunchedApp): Promise<SlotModelView> {
  await expectClaudeConnected(app.page, CLAUDE_PERSONAL);
  const key = offeringKey({ provider: "anthropic-claude", id: claudeStarter("high").id });
  await expect
    .poll(
      async () =>
        (await app.page.evaluate(() => window.infinitary.quota.models()))?.models.some(
          (row) => servedModelKey(row) === key,
        ) ?? false,
      { message: "This launch's model catalog names Opus", timeout: 0 },
    )
    .toBe(true);
  const view = await app.page.evaluate(() => window.infinitary.models.slots());
  const opus = view.models.find((model) => offeringKey(model) === key);
  if (!opus) throw new Error("The isolated Claude account did not serve Opus");
  return opus;
}

test("independent model reasoning persists, restores inherited defaults and recovers a refused save by keyboard", async () => {
  const userDataDir = scratchDir("infinitary-reasoning-");
  seedAccounts(userDataDir);
  const env = {
    // Dummy credentials never reach the provider's allowance endpoint.
    INFINITARY_CLAUDE_USAGE_URL: "http://127.0.0.1:9/usage",
    INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-stub-")),
  };
  const launch = () =>
    launchSignedInClaude(CLAUDE_PERSONAL, {
      withMockProvider: true,
      userDataDir,
      env,
    });
  let app = await launch();
  try {
    const opus = await catalogedOpus(app);
    const key = offeringKey(opus);
    const board = await open(app);
    const panel = await openModelPanel(app.page, levelLane(board, "high"), opus.label);
    await setLevelInPanel(panel, opus.label, "medium", true);
    await closeModelPanel(board);
    const high = board.getByRole("combobox", { name: reasoningLabel(opus, "high"), exact: true });
    const medium = board.getByRole("combobox", {
      name: reasoningLabel(opus, "medium"),
      exact: true,
    });
    await expect(high).toHaveValue("");
    await expect(medium).toHaveValue("");
    await high.selectOption("high");
    await expect(high).toHaveValue("high");
    await medium.selectOption("low");
    await expect(medium).toHaveValue("low");
    const snapshot = await app.page.evaluate(() => window.infinitary.models.slots());
    expect(
      snapshot.models.find((model) => `${model.provider}/${model.id}` === key)?.reasoning,
    ).toMatchObject({
      high: { chosen: "high", effective: { level: "high" } },
      medium: { chosen: "low", effective: { level: "low" } },
    });
    await refuseNext(app.app, "inf:models:reasoning:set");
    await high.selectOption("low");
    await expect(modelPill(board, "high", key).locator("..").getByRole("alert")).toBeVisible();
    await expect(high).toHaveValue("high");
    if (process.env.FM_REASONING_EVIDENCE_DIR)
      await regionShot(
        levelLane(board, "high"),
        join(process.env.FM_REASONING_EVIDENCE_DIR, "refusal-after.png"),
      );
    await expect(high).toBeEnabled();
    await expect(high).toHaveAttribute("aria-busy", "false");
    await focusOn(high);
    await pressKey(high, "l");
    await pressKey(high, "Enter");
    await expect(high).toHaveValue("low");
    await expect(high).toBeFocused();
    await expect(modelPill(board, "high", key).locator("..").getByRole("alert")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await app.page.evaluate(() => window.infinitary.models.slots())).models.find(
            (model) => `${model.provider}/${model.id}` === key,
          )?.reasoning?.high?.chosen,
      )
      .toBe("low");
    await high.selectOption("high");
    await expect(high).toHaveValue("high");
    await app.close();
    app = await launch();
    const relaunched = await catalogedOpus(app);
    const reopened = await open(app);
    await expect(
      reopened.getByRole("combobox", { name: reasoningLabel(relaunched, "high"), exact: true }),
    ).toHaveValue("high");
    await expect(
      reopened.getByRole("combobox", { name: reasoningLabel(relaunched, "medium"), exact: true }),
    ).toHaveValue("low");
    await reopened
      .getByRole("combobox", { name: reasoningLabel(relaunched, "high"), exact: true })
      .selectOption("");
    await expect(
      reopened.getByRole("combobox", { name: reasoningLabel(relaunched, "high"), exact: true }),
    ).toHaveValue("");
    expect(
      (await app.page.evaluate(() => window.infinitary.models.slots())).models.find(
        (model) => `${model.provider}/${model.id}` === key,
      )?.reasoning?.medium?.chosen,
    ).toBe("low");
  } finally {
    await app.close();
  }
});

test("new Quick crew conversations use the saved level while running conversations keep their opening reasoning", async () => {
  const app = await launchClaudeCrew();
  try {
    const board = await open(app);
    const starter = claudeStarter("low");
    const view = await app.page.evaluate(() => window.infinitary.models.slots());
    const model = view.models.find(
      (row) => row.provider === "anthropic-claude" && row.id === starter.id,
    );
    if (!model) throw new Error("The crew account did not offer its low starter");
    const control = board.getByRole("combobox", {
      name: reasoningLabel(model, "low"),
      exact: true,
    });
    await control.selectOption("high");
    await expect(control).toHaveValue("high");
    await pressKey(control, "Escape");
    const input = promptInput(app.page);
    const firstTitle = `reasoning first ${CLAUDE_CREW_PROMPT_MARKER}`;
    await input.fill(`commission a crewmate: ${firstTitle}`);
    await pressKey(input, "Enter");
    const findTask = async (title: string) =>
      (await app.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (row) => row.title === title,
      );
    await expect.poll(async () => (await findTask(firstTitle))?.id).toBeTruthy();
    const first = await findTask(firstTitle);
    if (!first) throw new Error("The first crew did not start");
    const detail = (id: string) =>
      app.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
    await expect.poll(async () => (await detail(first.id)).reasoning).toEqual({ level: "high" });
    await expect.poll(() => app.mockProvider?.heldRequests()).toBe(1);
    const reopened = await open(app);
    const next = reopened.getByRole("combobox", {
      name: reasoningLabel(model, "low"),
      exact: true,
    });
    await next.selectOption("");
    await expect(next).toHaveValue("");
    await pressKey(next, "Escape");
    const secondTitle = `reasoning second ${CLAUDE_CREW_PROMPT_MARKER}`;
    await input.fill(`commission a crewmate: ${secondTitle}`);
    await pressKey(input, "Enter");
    await expect.poll(async () => (await findTask(secondTitle))?.id).toBeTruthy();
    const second = await findTask(secondTitle);
    if (!second) throw new Error("The second crew did not start");
    await expect
      .poll(async () => (await detail(second.id)).reasoning)
      .toEqual({ level: "low", lower: "quick" });
    expect((await detail(first.id)).reasoning).toEqual({ level: "high" });
    await expect.poll(() => app.mockProvider?.heldRequests()).toBe(2);
    const evidence = {
      first: await detail(first.id),
      second: await detail(second.id),
      requests: app.mockProvider?.requestBodies().flatMap((body) => {
        const request = JSON.parse(body) as { model?: string; output_config?: { effort?: string } };
        return request.output_config
          ? [{ model: request.model, output_config: request.output_config }]
          : [];
      }),
    };
    writeFileSync(
      join(
        process.env.FM_REASONING_EVIDENCE_DIR ?? test.info().outputPath("."),
        "crew-reasoning.json",
      ),
      JSON.stringify(evidence, null, 2),
    );
    expect(evidence.requests?.some((request) => request.output_config.effort === "high")).toBe(
      true,
    );
    expect(evidence.requests?.some((request) => request.output_config.effort === "low")).toBe(true);
    app.mockProvider?.releaseHeldCrew();
  } finally {
    await app.close();
  }
});
