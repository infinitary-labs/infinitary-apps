import { expect, test } from "@playwright/test";
import { WELCOME_TITLE } from "@shared/welcome";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { scratchDir } from "../helpers/scratchDirs";
import { putAwayFirstCrewmateNote } from "./firstLaunch";
import { gitIdentityHome } from "./homeFixtures";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { mockProviderOverrideModelsJson } from "./mockModels";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { windowShot } from "./pictures";
import { promptInput } from "./prompt";
import { startedLine, taskKey } from "./rails";
import {
  DESTINATION_STORY_MARKER,
  DESTINATION_STORY_TITLE,
  destinationStory,
} from "./scenarios/destinationStory";
import { expectNoCard, noteDone, shownCard, stageAtRest } from "./stack";

/**
 * A crewmate on an install signed in only to OpenRouter (INF-2523). Nothing
 * reads OpenRouter's allowance, so its models have no allowance row, and
 * the crewmate the first mate started opened with no model and no account:
 * its first turn failed as if the key had lapsed. Routing now admits a
 * model by its slot alone, and with nothing placed the slot record's
 * fallback places OpenRouter's listed aliases, so the crewmate starts on
 * one of them under the key.
 *
 * Its data is a fresh profile and HOME, a git identity in that HOME, the
 * stand-in behind the OpenRouter key the gate signs in, and the saved-story
 * scenario its crewmate follows. It shares no sign-in, keychain, account or
 * folder with another journey, and needs no Mac. Its completion signal is
 * the crewmate's card on the stage, with the task's record naming an
 * OpenRouter model and every crewmate turn the stand-in saw sent under the
 * key on that model.
 */

const PROJECT = "keylab";
/** The key pasted through the gate's chip; the stand-in reads it back. */
const KEY = "sk-or-openrouter-crew";

/** Where each section stood, kept with the run's results. */
const picture = (name: string) => test.info().outputPath(`${name}.png`);

test("a crewmate on an install signed in only to OpenRouter runs on an OpenRouter model under that key", async () => {
  test.setTimeout(3 * 60_000);
  const launched = await launchApp({
    withMockProvider: true,
    // The base runtime serves no model, so the gate shows; the key the gate
    // signs in reads the same file and sends every turn to the stand-in.
    modelsJson: (port) => mockProviderOverrideModelsJson(port, "openrouter"),
    scenarios: [destinationStory(true)],
    prepareHome: gitIdentityHome("OpenRouter Crew", "openrouter-crew@localhost"),
    env: { INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")) },
  });
  try {
    const { app, page, mockProvider } = launched;
    if (!mockProvider) throw new Error("The journey needs its stand-in provider.");
    await resizeWindow(app, page, { width: 1280, height: 1000 });
    const input = promptInput(page);
    const gate = page.locator("[data-first-run-gate]");

    await test.step("sign in: an OpenRouter key pasted through the gate's chip is the only sign-in", async () => {
      await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
      await gate.locator('[data-connect-provider="openrouter"]').click();
      await gate.locator("[data-connect-method]").getByRole("button", { name: "API key" }).click();
      const aside = gate.locator("[data-connect-aside]");
      await aside.locator("input[type='password']").fill(KEY);
      await aside.getByRole("button", { name: "Submit" }).click();
      await expect(input).toBeEnabled();
      const welcome = shownCard(page, WELCOME_TITLE);
      await expect(welcome).toBeVisible();
      // INF-2794: the welcome note leaves through its own Got it.
      await noteDone(page, welcome).click();
      await expectNoCard(page, WELCOME_TITLE);
      const accounts = await page.evaluate(() => window.infinitary.accounts.list());
      expect(accounts.map((account) => account.providerId)).toEqual(["openrouter"]);
    });

    await test.step("project: a new project started in Settings", async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Projects", exact: true }).click();
      const add = page.locator("[data-add-project]");
      await add.getByRole("button", { name: "New project", exact: true }).click();
      await add.getByLabel("Name", { exact: true }).fill(PROJECT);
      await add.getByRole("button", { name: "Start project" }).click();
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.infinitary.repos.list())).some(
            (repo) => repo.name === PROJECT,
          ),
        )
        .toBe(true);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(input).toBeVisible();
    });

    const title = `${PROJECT} ${DESTINATION_STORY_MARKER}`;
    await test.step("crewmate: the started crewmate runs on an OpenRouter model under the key and comes back with its card", async () => {
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      const key = await taskKey(page, title);
      await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
      // A new person's first crewmate brings its once-only note.
      await putAwayFirstCrewmateNote(page);
      const card = shownCard(page, DESTINATION_STORY_TITLE);
      await expect(card).toBeVisible({ timeout: 60_000 });
      const board = await page.evaluate(() => window.infinitary.tasks.board());
      const task = board.tasks.find((row) => row.key === key);
      if (!task) throw new Error("The started task is not on the board.");
      const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id);
      // Routing chose one of OpenRouter's listed aliases, at the medium slot
      // the fallback placed it in.
      expect(detail?.model).toMatch(/^openrouter\/~/);
      expect(detail?.tier).toBe("medium");
      const model = detail?.model?.slice("openrouter/".length);
      const bodies = mockProvider.requestBodies();
      const headers = mockProvider.requestHeaders();
      // OpenRouter's Anthropic aliases speak Anthropic's dialect, which
      // sends the key as `x-api-key`; its other models send it as a bearer.
      const keyOf = (index: number) =>
        headers[index]?.["x-api-key"] ?? headers[index]?.authorization?.replace(/^Bearer /, "");
      const crewTurns = bodies.flatMap((body, index) =>
        body.includes(FIRSTMATE_PERSONA)
          ? []
          : [{ model: JSON.parse(body).model, key: keyOf(index) }],
      );
      expect(crewTurns.length).toBeGreaterThan(0);
      for (const turn of crewTurns) {
        expect(turn).toEqual({ model, key: KEY });
      }
      await stageAtRest(page);
      await windowShot(page, picture("crewmate-card"));
    });
  } finally {
    await launched.close();
  }
});
