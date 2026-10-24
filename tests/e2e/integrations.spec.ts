import { expect, test } from "@playwright/test";
import {
  INTEGRATION_RULE_WORDS,
  INTEGRATIONS_MCP_WORDS,
  INTEGRATIONS_WORDS,
} from "../../src/shared/integrations";
import { scratchDir } from "../helpers/scratchDirs";
import { type GitHubStub, STUB_LOGIN, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { holdFrames } from "./heldFrames";
import { type LaunchedApp, launchApp } from "./launch";
import { settingsSection } from "./settings";
import { pressKey, runFromSearch, untilFocused } from "./windowKeys";

/**
 * Settings -> Integrations from the keyboard (INF-775 piece 1; the
 * captain's "there should be an "integrations" tab in settings. both user
 * and first mate agent should have the same acsess to manage it"; the
 * keyboard principle, docs/keyboard.md "A new feature").
 *
 * - Promised result: command search's Open Integrations shows the tab with
 *   focus on the GitHub row, Enter opens its actions, Space on an action's
 *   switch turns it off, and the row's menu pauses GitHub, each change held
 *   by the core's own view, the one the first mate's `app_change` writes.
 * - Data: a github.com sign-in already on file (`seedGitHubSignIn`), which
 *   the app's real health read checks against the local GitHub stand-in.
 * - Completion signal: `window.infinitary.integrations.list()` answers the
 *   action off and the row paused, and the row draws both.
 * - Platform prerequisites: none beyond the hermetic launcher; nothing
 *   reaches github.com.
 * - Shared resources: none; the app, its folder and the stand-in are this
 *   test's own.
 */

let launched: LaunchedApp | undefined;
let github: GitHubStub | undefined;

test.afterEach(async () => {
  await launched?.close();
  await github?.close();
});

test("Open Integrations reaches the GitHub row, its actions and its menu by keys alone", async () => {
  const userDataDir = scratchDir("infinitary-integrations-");
  seedGitHubSignIn(userDataDir);
  github = await startGitHubStub();
  launched = await launchApp({ withMockProvider: true, userDataDir, env: github.env });
  const { app, page } = launched;
  const view = () => page.evaluate(() => window.infinitary.integrations.list());
  await expect
    .poll(async () => (await view()).integrations.map((row) => [row.id, row.health, row.account]), {
      timeout: 15_000,
    })
    .toEqual([["github", "ok", STUB_LOGIN]]);

  await runFromSearch(app, page, "settings.integrations");
  const tab = settingsSection(page, "integrations");
  await expect(tab).toContainText(INTEGRATIONS_WORDS.intro);
  const row = tab.locator('[data-integration-row="github"]');
  await expect(row).toContainText(`as ${STUB_LOGIN}`);
  const toggle = row.locator('[data-integration-toggle="github"]');
  await untilFocused(toggle);

  // INF-950: existing connections also start with every action asking.
  await pressKey(toggle, "Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const actions = tab.locator('[data-integration-actions="github"]');
  await expect(
    actions.locator('[data-integration-action="read"] [data-integration-rule]'),
  ).toHaveText(INTEGRATION_RULE_WORDS.ask);
  const write = actions.locator('[data-integration-action="write"]');
  await expect(write.locator("[data-integration-rule]")).toHaveText(INTEGRATION_RULE_WORDS.ask);

  // Space on the switch turns the change off, for every caller.
  await pressKey(write.getByRole("switch"), " ");
  await expect(write.locator("[data-integration-rule]")).toHaveText(INTEGRATION_RULE_WORDS.never);
  await expect
    .poll(async () =>
      (await view()).integrations[0]?.actions.map((action) => [action.name, action.rule]),
    )
    .toEqual([
      ["read", "ask"],
      ["write", "never"],
    ]);

  // The row's menu pauses it.
  await pressKey(row.getByRole("button", { name: "GitHub actions" }), "Enter");
  await pressKey(page.getByRole("menuitem", { name: "Pause" }), "Enter");
  await expect(row).toContainText("paused");
  await expect.poll(async () => (await view()).integrations[0]?.paused).toBe(true);
});

/**
 * INF-963: Open Integrations puts focus on the first row once the tab draws,
 * a frame after the command, and a window that paints late - hosted Linux
 * under two workers - draws that frame after the person has pressed into the
 * tab. Its focus then took the MCP form's name field from
 * `older-profile.spec.ts` and left the keys typed next in the row.
 *
 * - Promised result: focus a person moved into the tab before that frame,
 *   the name field of the MCP server form, keeps its place once the frame
 *   comes.
 * - Data: the same github.com sign-in on file, so the tab draws a row the
 *   command would put focus on.
 * - Completion signal: the window's held frames run (`holdFrames`), the
 *   command's own among them, and the name field still holds focus after.
 * - Platform prerequisites: none beyond the hermetic launcher.
 * - Shared resources: none; the app, its folder and the stand-in are this
 *   test's own.
 */
test("Open Integrations leaves focus a person moved into the tab before a late frame", async () => {
  const userDataDir = scratchDir("infinitary-integrations-");
  seedGitHubSignIn(userDataDir);
  github = await startGitHubStub();
  launched = await launchApp({ withMockProvider: true, userDataDir, env: github.env });
  const { app, page } = launched;
  const tab = settingsSection(page, "integrations");
  const frames = await holdFrames(page.locator("body"));
  await runFromSearch(app, page, "settings.integrations");
  await expect(tab.locator('[data-integration-row="github"]')).toBeVisible();
  await pressKey(tab.locator('[data-integration-add="mcp"] button'), "Enter");
  const name = tab.locator("[data-integration-mcp-form]").getByLabel(INTEGRATIONS_MCP_WORDS.name);
  await untilFocused(name);
  await frames.release();
  expect(await name.evaluate((field) => field.ownerDocument.activeElement === field)).toBe(true);
});
