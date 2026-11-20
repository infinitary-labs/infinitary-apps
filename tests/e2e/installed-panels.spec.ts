import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { panelAddedLine, panelRemovedLine } from "../../src/core/personal/panelLines";
import {
  CAN_READ_WORDS,
  panelByWords,
  panelConsentTitle,
  SENDS_NOTHING_WORDS,
} from "../../src/core/plugins/consentWords";
import { YOUR_PANELS_WORDS } from "../../src/renderer/src/settings/generalWords";
import { viewWords } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { cardBody, frameIn, panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";

import { promptInput } from "./prompt";
import { feedLine } from "./rails";
import { ADD_PANEL_PROMPT_MARKER, installPanel } from "./scenarios/installPanel";
import { PERSONAL_REMOVE_PROMPT_MARKER, personalPanels } from "./scenarios/personalPanels";
import { settingRow } from "./settings";
import { expectNoCard, shownCard } from "./stack";

/**
 * Install by talking, end to end (one plugin vehicle, Phase A items 2, 3
 * and 5; the captain's A2a and A3a): the captain asks the Firstmate to add
 * a panel someone else made from a folder on his Mac; the real Firstmate
 * session makes ONE install_plugin call through the mock provider; the host
 * fetches, pins and checks the folder and puts its own consent card up -
 * nothing is added until his click on "Add it"; then the panel docks,
 * attributed by its author's name, with one feed line; the one switch in
 * Settings takes it back with his own panels and brings it back; and
 * "remove my panel" takes it away with its files.
 *
 * The folder is the `usage` skill's token dashboard, a real multi-file
 * panel on the app's own components, given the name and version an added
 * panel needs. Its code never runs in the app's window: the frame realm
 * (Phase A item 4) draws it in a sandboxed frame, reading the one view it
 * was consented through the host.
 */
type Snapshot = Awaited<ReturnType<Window["firstmate"]["plugins"]["personal"]["list"]>>;

/** The title, maker and version the spec writes into the folder's manifest. */
const PANEL_TITLE = "Token meter";
const MAKER = "Acme";
const VERSION = "1.0.0";
/** The host's consent card for it. */
const CARD_TITLE = panelConsentTitle(PANEL_TITLE, MAKER);

let launched: LaunchedApp;
let source: string;

async function say(page: Page, words: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(words);
  await input.press("Enter");
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.infinitary.plugins.personal.list());
}

function panelsSwitch(page: Page) {
  return page.locator('[data-setting="your-panels"] [role="switch"]');
}

test.describe
  .serial("adding a panel someone else made, by talking (Phase A)", () => {
    test.beforeAll(async () => {
      source = join(scratchDir("infinitary-e2e-panel-source-"), "token-meter");
      cpSync(join(process.cwd(), "tests", "fixtures", "personal-skills", "token-watch"), source, {
        recursive: true,
      });
      const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        join(source, "manifest.json"),
        JSON.stringify({ ...manifest, name: MAKER, version: VERSION, title: PANEL_TITLE }),
      );
      launched = await launchApp({
        scenarios: [installPanel, personalPanels],
        withMockProvider: true,
      });
    });

    test.afterAll(async () => {
      await launched.close();
    });

    test("the ask, the consent card, Add it, the one switch, and remove my panel", async () => {
      const { page, userDataDir } = launched;
      await test.step("the ask becomes one consent card from the host, and nothing is added before the captain says yes", async () => {
        await say(page, `${ADD_PANEL_PROMPT_MARKER}${source}`);
        await expect(shownCard(page, CARD_TITLE)).toBeVisible({ timeout: 30_000 });
        const body = cardBody(page, CARD_TITLE);
        await expect(body.locator("body")).toContainText(panelByWords(MAKER, VERSION));
        await expect(body.locator("body")).toContainText(
          `${CAN_READ_WORDS} ${viewWords("v_usage_v1")}`,
        );
        await expect(body.locator("body")).toContainText(SENDS_NOTHING_WORDS);
        await page.screenshot({ path: test.info().outputPath("installed-panels-consent.png") });

        // The host's card is the only one about it: the Firstmate authored none.
        const cards = await page.evaluate(() => window.infinitary.cards.list());
        expect(cards.filter((card) => card.author === "host").map((card) => card.title)).toEqual([
          CARD_TITLE,
        ]);
        expect(
          cards.filter(
            (card) => card.author !== "host" && `${card.title} ${card.body}`.includes(PANEL_TITLE),
          ),
        ).toEqual([]);
        // Staged, not added.
        expect((await snapshot(page)).extensions).toEqual([]);
        expect(existsSync(join(userDataDir, "plugins", "token-meter"))).toBe(false);
        await expect(page.locator('[data-side-panel="token-meter"]')).toHaveCount(0);
        // The Firstmate's turn has ended; the consent card hides its frame.
        await waitForFirstmateIdle(page);
      });

      await test.step("Add it docks the panel, attributed by its author's name, with one feed line", async () => {
        await page.getByRole("button", { name: "Add it", exact: true }).click();
        await expect(feedLine(page, panelAddedLine(PANEL_TITLE, MAKER))).toBeVisible({
          timeout: 30_000,
        });
        await expectNoCard(page, CARD_TITLE);

        const panel = page.locator('[data-side-panel="token-meter"]');
        await expect(panel).toBeVisible();
        await expect(panel.locator("header")).toContainText(PANEL_TITLE);
        await expect(panel.locator("[data-side-panel-attribution]")).toHaveText(MAKER);
        // Its code never runs in the app's window: the frame realm draws it, in
        // a sandboxed frame at a host of its own, from the app's own components
        // and the one view the captain agreed to.
        await expect(frameIn(panel)).toHaveAttribute("src", /^app-frame:\/\/panel-[0-9a-f-]+\/$/);
        const drawn = panelBody(page, "token-meter");
        await expect(drawn.getByText("Tokens · last hour")).toBeVisible({ timeout: 15_000 });
        await expect(drawn.getByText("Firstmate", { exact: true })).toBeVisible({
          timeout: 15_000,
        });
        await page.screenshot({ path: test.info().outputPath("installed-panels-docked.png") });

        const [view] = (await snapshot(page)).extensions;
        expect(view).toMatchObject({
          id: "token-meter",
          source: "installed",
          by: MAKER,
          present: true,
          sql: ["v_usage_v1"],
          panel: null,
          server: null,
          error: null,
        });
        expect(existsSync(join(userDataDir, "plugins", "token-meter", "panel.tsx"))).toBe(true);
        expect(existsSync(join(userDataDir, "plugins", "token-meter", "tokens.ts"))).toBe(true);
      });

      await test.step("the one switch takes it back with the captain's own panels, and brings it back", async () => {
        const panel = page.locator('[data-side-panel="token-meter"]');
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await expect(settingRow(page, "your-panels").getByText(YOUR_PANELS_WORDS.on)).toBeVisible();
        await panelsSwitch(page).click();
        await expect(panelsSwitch(page)).toHaveAttribute("aria-checked", "false");
        await expect.poll(async () => (await snapshot(page)).extensions).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);

        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await panelsSwitch(page).click();
        await expect(panelsSwitch(page)).toHaveAttribute("aria-checked", "true");
        await page.keyboard.press("Escape");
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect(panel.locator("[data-side-panel-attribution]")).toHaveText(MAKER);
      });

      await test.step("remove my panel takes it away with its files", async () => {
        await say(page, `${PERSONAL_REMOVE_PROMPT_MARKER}token-meter`);
        await expect(feedLine(page, panelRemovedLine(PANEL_TITLE, MAKER))).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.locator('[data-side-panel="token-meter"]')).toHaveCount(0);
        expect((await snapshot(page)).extensions).toEqual([]);
        expect(existsSync(join(userDataDir, "plugins", "token-meter"))).toBe(false);
        // The words plugin and extension reached no surface along the way.
        // biome-ignore lint/plugin/e2e-text-lookup: a vocabulary boundary - these words must reach no surface anywhere
        await expect(page.getByText(/extension|plugin/i)).toHaveCount(0);
      });
    });
  });
