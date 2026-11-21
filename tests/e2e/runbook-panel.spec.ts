import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { panelCommandId } from "../../src/shared/keyboard";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { shownPanelCard } from "./panelCards";
import { regionShot, windowShot } from "./pictures";
import { settingRow } from "./settings";
import { commandSearch, focusOn, pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * A runbook of the captain's own shows its panels while it is on
 * (docs/runbooks.md, "Panels"; the captain's ask that runbooks can include
 * panels). The throwaway workspace holds a runbook whose manifest lists one
 * panel folder, the panel-cards fixture with a command. The journey turns
 * the runbook on in Settings → Runbooks by keys, finds its panel on the rail
 * and its command in command search, runs the command to put the panel's
 * card up, then turns it off and finds the panel, its card and its command
 * gone.
 * Data: the real panel-cards fixture and a runbook written as a person's own;
 * no account, network or shared resource. Completion signals: the switch's
 * checked state, the panel's frame drawing its fixture, the card on the
 * stack, and the command row.
 */

const RUNBOOK = "reading-desk";
const FOLDER = "reading";
/** A runbook panel's id: its runbook's and its folder's. */
const PANEL = `${RUNBOOK}-${FOLDER}`;
const FIXTURE = join(process.cwd(), "tests", "fixtures", "panel-cards", "reading-list");

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument before testInfo.
test("a runbook of your own shows its panel only while it is on", async ({}, testInfo) => {
  const userDataDir = scratchDir("infinitary-e2e-runbook-panel-");
  const folder = join(userDataDir, "fleet", "personal", "runbooks", RUNBOOK);
  mkdirSync(folder, { recursive: true });
  // e2e-fixture: input -- Author the person's own runbook and its panel folder, the input this journey shows.
  cpSync(FIXTURE, join(folder, FOLDER), { recursive: true });
  // e2e-fixture: input -- Author the runbook's manifest that lists the panel folder.
  writeFileSync(
    join(folder, "runbook.json"),
    JSON.stringify({
      id: RUNBOOK,
      name: "Reading desk",
      description: "Keeps a reading list beside your work.",
      author: "You",
      version: "1.0.0",
      panels: [FOLDER],
      startsOff: true,
    }),
  );
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { app, page } = launched;
  try {
    await resizeWindow(app, page, { width: 1600, height: 900 });
    const panel = page.locator(`[data-side-panel="${PANEL}"]`);
    await pressWindowKey(app, ",", ["meta"]);
    const tab = page.locator('[role="tab"][id$="-tab-runbooks"]');
    await focusOn(tab);
    await pressKey(tab, "Enter");
    const row = settingRow(page, `runbook-${RUNBOOK}`);
    const control = row.getByRole("switch");
    await expect(control).toHaveAttribute("aria-checked", "false");
    // The row names what turning it on will show.
    await expect(row.locator("[data-runbook-panels]")).toContainText("Reading list");
    await regionShot(row, testInfo.outputPath("runbooks-row.png"));
    await expect(panel).toHaveCount(0);

    await focusOn(control);
    await pressKey(control, "Space");
    await expect(control).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(panelBody(page, PANEL).locator("[data-fixture]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.locator("[data-side-panel-attribution]")).toHaveText("Reading desk");
    await windowShot(page, testInfo.outputPath("window-on.png"));
    const search = commandSearch(page);
    await pressWindowKey(app, "k", ["meta"]);
    await search.field.fill("reading");
    await expect(search.row(panelCommandId(PANEL, "open"))).toBeVisible();
    await page.keyboard.press("Escape");
    // Its command puts the panel's card up on the stack.
    const card = shownPanelCard(page, PANEL, "reader");
    await runFromSearch(app, page, panelCommandId(PANEL, "open"));
    await expect(card).toBeVisible();

    await pressWindowKey(app, ",", ["meta"]);
    await focusOn(tab);
    await pressKey(tab, "Enter");
    await focusOn(control);
    await pressKey(control, "Space");
    await expect(control).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    // The card it put up goes with it.
    await expect(card).toHaveCount(0);
    await pressWindowKey(app, "k", ["meta"]);
    await search.field.fill("reading");
    await expect(search.row(panelCommandId(PANEL, "open"))).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    await launched.close();
  }
});
