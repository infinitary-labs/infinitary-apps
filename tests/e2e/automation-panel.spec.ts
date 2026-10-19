import { expect, type Page, test } from "@playwright/test";
import { Scheduler } from "../../src/core/orchestrator/scheduler";
import { openDatabase } from "../../src/core/storage/db";
import { ScheduleStore } from "../../src/core/storage/scheduleStore";
import automationManifest from "../../src/panels/automation/manifest.json" with { type: "json" };
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { panelHeaderButton } from "./panelCards";
import { settingsSection } from "./settings";
import { pressKey } from "./windowKeys";

/**
 * The Automation panel's Open Automation (docs/automation.md, "The
 * Automation panel"), the captain's ask: "the automation panel should also
 * have an expand button that takes me to the full set of automations in the
 * settings page".
 *
 * - Promised result: the expanded panel's header button, by a click and by
 *   Enter, opens Settings → Automation at its list of every saved rule, with
 *   no rule's sheet open.
 * - Data: two rules saved through the core's own `Scheduler` before the
 *   launch - one running, one draft - so the list is the whole set, not the
 *   one rule a row would open.
 * - Completion signal: the Automation tab is the shown Settings section and
 *   holds a row for each saved rule.
 * - Platform prerequisites: none beyond the hermetic launcher.
 * - Shared resources: none; its own userData and HOME.
 */

const PANEL = "automation";
const RUNNING = "Weekly dependency audit";
const DRAFT = "Release notes reminder";

/** The panel on its rail. */
function automationPanel(page: Page) {
  return page.locator(`[data-side-panel="${PANEL}"]`);
}

/** The header's Open Automation, by its id in the panel's manifest. */
function openAutomation(page: Page) {
  return panelHeaderButton(page, PANEL, "open").getByRole("button");
}

/** Settings → Automation at its full list: a row for each rule, and no sheet. */
async function expectFullList(page: Page, ids: readonly string[]): Promise<void> {
  const tab = settingsSection(page, PANEL);
  await expect(tab).toBeVisible();
  for (const id of ids) await expect(tab.locator(`[data-automation-row="${id}"]`)).toBeVisible();
  await expect(tab.locator("[data-automation-row]")).toHaveCount(ids.length);
  await expect(tab.locator("[data-automation-sheet]")).toHaveCount(0);
}

test("Open Automation in the panel's header opens Settings at every automation, by click and by Enter", async () => {
  const userDataDir = scratchDir("infinitary-automation-panel-");
  const db = openDatabase(userDataDir);
  const scheduler = new Scheduler({
    store: new ScheduleStore(db),
    notify: () => null,
    broadcastEvent: () => {},
  });
  // Weeks away, so neither fires while the journey runs.
  const later = Date.now() + 28 * 24 * 60 * 60_000;
  const ids = [
    scheduler.create({ kind: "once", at: later }, "Audit the dependencies.", true, RUNNING).id,
    scheduler.create(
      { kind: "once", at: later },
      "Draft the release notes.",
      true,
      DRAFT,
      undefined,
      { draft: true },
    ).id,
  ];
  db.close();

  const { page, close } = await launchApp({ userDataDir });
  try {
    const panel = automationPanel(page);
    await expect(panel).toBeAttached({ timeout: 30_000 });
    await panel.getByRole("button", { name: `Expand ${automationManifest.title}` }).click();
    await expect(panel).not.toHaveAttribute("data-side-panel-collapsed", "");

    await test.step("a click opens Settings → Automation at the full list", async () => {
      await openAutomation(page).click();
      await expectFullList(page, ids);
    });

    await test.step("back home, Enter on the focused button does the same", async () => {
      await page.keyboard.press("Escape");
      await expect(panel).toBeVisible();
      await pressKey(openAutomation(page), "Enter");
      await expectFullList(page, ids);
    });
  } finally {
    await close();
  }
});
