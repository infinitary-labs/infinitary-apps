import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { englishOf, said } from "../../src/shared/i18n/said";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { seedPersonalWorkspace } from "./personalFixtures";
import { promptInput } from "./prompt";
import { ADD_PANEL_PROMPT_MARKER, installPanel } from "./scenarios/installPanel";
import { shownCardFrame } from "./stack";

/**
 * A panel changes the settings it was granted the way the first mate does
 * (docs/ui-plugins.md, "Changing settings"), driven through the look fixture
 * under tests/fixtures/panel-settings/: its change on the captain's click
 * lands and Activity names the panel, its change as it opens with no click
 * of his writes nothing, and a setting its manifest does not name is
 * refused. Once as a panel of his own, once added from elsewhere after its
 * approval card lists each setting.
 */

const PANEL = "look";
/** Why a change made without the captain's own press wrote nothing (`panelSettings.ts`). */
const CHANGE_NOT_ASKED = englishOf(said("panelChangeNotAsked"));
const FIXTURE = join(process.cwd(), "tests", "fixtures", "panel-settings", PANEL);

const appearance = (page: Page) => page.evaluate(() => window.infinitary.settings.getAppearance());

/** Activity's lines as the core keeps them, oldest first. */
async function activityLines(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.infinitary.feed.recent())).map((line) => line.text);
}

/** The panel's click changes the theme, names the panel, and nothing else gets through. */
async function changesOnlyOnHisClick(page: Page): Promise<void> {
  const look = panelBody(page, PANEL).locator("[data-fixture-look]");
  await test.step("its change as it opens, with no click of his, writes nothing", async () => {
    await expect(look.locator("[data-look-unasked]")).toHaveText(CHANGE_NOT_ASKED, {
      timeout: 30_000,
    });
    expect((await appearance(page)).theme).toBe("dark");
  });

  await test.step("a click in it changes the theme as the captain, and Activity names the panel", async () => {
    // e2e-frame-actions: native -- This journey proves a real pointer grants permission to change a setting.
    await look.locator("[data-look-light]").click();
    await expect(look.locator("[data-look-said]")).toHaveText("changed");
    await expect.poll(async () => (await appearance(page)).theme).toBe("light");
    const named = englishOf(said("feedCaptainSetInPanel", { text: "", panel: "Look" }));
    await expect
      .poll(async () => (await activityLines(page)).some((line) => line.startsWith(named)))
      .toBe(true);
  });

  await test.step("each later click in it changes the setting it names", async () => {
    // e2e-frame-actions: native -- This journey proves a real pointer grants permission to change a setting.
    await look.locator("[data-look-dark]").click();
    await expect.poll(async () => (await appearance(page)).theme).toBe("dark");
    const before = await appearance(page);
    // e2e-frame-actions: native -- This journey proves a real pointer grants permission to change a setting.
    await look.locator("[data-look-larger]").click();
    await expect.poll(() => appearance(page)).toEqual({ ...before, size: 110 });
  });

  await test.step("a setting its manifest does not name is refused in the app's words", async () => {
    // e2e-frame-actions: native -- This journey proves the core refuses a setting the panel was not granted.
    await look.locator("[data-look-unlisted]").click();
    await expect(look.locator("[data-look-said]")).toHaveText(
      englishOf(said("panelChangeNotGranted", { setting: "crew-model-names" })),
    );
  });
}

test.describe("a panel of the captain's own changes the settings it names", () => {
  let launched: LaunchedApp;

  test.beforeEach(async () => {
    const userDataDir = scratchDir("infinitary-e2e-panel-settings-");
    seedPersonalWorkspace(userDataDir, FIXTURE, PANEL);
    launched = await launchApp({ userDataDir, withMockProvider: true });
    await resizeWindow(launched.app, launched.page, { width: 1400, height: 900 });
  });

  test.afterEach(async () => {
    await launched.close();
  });

  test("changes a setting on his click only, and Activity names it", async () => {
    test.setTimeout(120_000);
    await changesOnlyOnHisClick(launched.page);
  });
});

test.describe("a panel from elsewhere changes settings only after the captain agrees", () => {
  let launched: LaunchedApp;
  let source: string;

  test.beforeEach(async () => {
    const userDataDir = scratchDir("infinitary-e2e-panel-settings-added-");
    source = join(scratchDir("infinitary-e2e-panel-settings-source-"), PANEL);
    cpSync(FIXTURE, source, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({ ...manifest, name: "Acme", version: "1.0.0" }),
    );
    launched = await launchApp({ scenarios: [installPanel], userDataDir, withMockProvider: true });
    await resizeWindow(launched.app, launched.page, { width: 1400, height: 900 });
  });

  test.afterEach(async () => {
    await launched.close();
  });

  test("lists each setting on its approval card, then changes one on his click", async () => {
    test.setTimeout(120_000);
    const { page } = launched;

    await test.step("the approval card lists each setting it may change, and only his click adds it", async () => {
      const input = promptInput(page);
      await input.click();
      await input.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
      await input.press("Enter");
      const add = page.getByRole("button", { name: "Add it", exact: true });
      await add.waitFor({ timeout: 30_000 });
      const body = shownCardFrame(page).locator("body");
      await expect(body).toContainText(englishOf(said("panelChangesIntro")));
      await expect(body.locator("li")).toHaveText([
        englishOf(said("panelChangeTheme")),
        englishOf(said("panelChangeWindowSize")),
      ]);
      await add.click();
    });

    await changesOnlyOnHisClick(page);
  });
});
