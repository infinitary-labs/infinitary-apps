import { expect, test } from "@playwright/test";
import { AUTOMATION_STATE_WORDS } from "@shared/automationWords";
import { automationWords, Scheduler } from "../../src/core/orchestrator/scheduler";
import { openDatabase } from "../../src/core/storage/db";
import { ScheduleStore } from "../../src/core/storage/scheduleStore";
import { scratchDir } from "../helpers/scratchDirs";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { feedLineOf } from "./rails";
import { settingsSection } from "./settings";

/**
 * INF-752: "Everything the captain can do to a schedule in Settings →
 * Automation (edit, pause, resume, pause all, delete, turn on a draft) the
 * first mate can do through the same path, and Automation's own changes
 * leave the same trail." (docs/automation.md, "One owner" and "Who changed
 * it").
 *
 * - Promised result: the captain's Pause in a rule's sheet leaves one
 *   Activity line naming the captain; asked, the first mate turns the draft
 *   on and deletes the paused rule through the same catalog lines, each with
 *   one Activity line naming the first mate, and Settings → Automation shows
 *   the draft running and the deleted rule gone.
 * - Data: two rules saved through the core's own `Scheduler` before the
 *   launch - a weekly audit the captain asked for, and a daily digest nobody
 *   directed, which waits as a draft.
 * - Completion signal: each Activity line, by the Scheduler's own words and
 *   who made the change; the rules as the app reads them, and their rows.
 * - Platform prerequisites: none beyond the hermetic launcher and its
 *   stand-in model, which runs a catalog change on the captain's words.
 * - Shared resources: none; its own userData and HOME.
 */

const AUDIT = "Weekly dependency audit";
const DIGEST = "Morning digest";

test("Settings → Automation's changes and the first mate's take one path and name who made them", async () => {
  const userDataDir = scratchDir("infinitary-automation-actions-");
  const db = openDatabase(userDataDir);
  const scheduler = new Scheduler({
    store: new ScheduleStore(db),
    notify: () => null,
    broadcastEvent: () => {},
  });
  const audit = scheduler.create(
    {
      kind: "weekly",
      days: [(new Date().getDay() + 3) % 7],
      hour: 9,
      minute: 0,
      timeZone: "America/Los_Angeles",
    },
    "Audit the dependencies and report anything out of date.",
    true,
    AUDIT,
  );
  const digest = scheduler.create(
    { kind: "daily", hour: 8, minute: 0, timeZone: "America/Los_Angeles" },
    "Summarize what the crew finished overnight.",
    false,
    DIGEST,
  );
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    const rules = () =>
      page.evaluate(async () => {
        const list = await window.infinitary.automation.list();
        return Object.fromEntries(list.rules.map((rule) => [rule.id, rule.state]));
      });
    // Each ask ends on the first mate's answer, never on the character looking idle,
    // which it does before the turn starts.
    const ask = (action: string, value: unknown) =>
      askFirstmate(page, APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
    const openAutomation = async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Automation", exact: true }).click();
      return settingsSection(page, "automation");
    };

    let tab = await openAutomation();
    await tab.locator(`[data-automation-row="${audit.id}"]`).getByRole("button").first().click();
    await tab.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(tab.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      feedLineOf(page, {
        type: "personalized",
        text: automationWords.paused(audit),
        actor: "captain",
      }),
    ).toHaveCount(1);

    await ask("automation-edit", { id: digest.id, enable: true });
    await expect(
      feedLineOf(page, {
        type: "personalized",
        text: automationWords.saved(true, digest.spec, digest.prompt),
        actor: "firstmate",
      }),
    ).toHaveCount(1);
    await expect.poll(rules).toEqual({ [audit.id]: "paused", [digest.id]: "enabled" });

    await ask("automation-delete", { id: audit.id });
    await expect(
      feedLineOf(page, {
        type: "personalized",
        text: automationWords.cancelled(audit.prompt),
        actor: "firstmate",
      }),
    ).toHaveCount(1);
    await expect.poll(rules).toEqual({ [digest.id]: "enabled" });

    tab = await openAutomation();
    await expect(tab.locator(`[data-automation-row="${audit.id}"]`)).toHaveCount(0);
    const row = tab.locator(`[data-automation-row="${digest.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).not.toContainText(AUTOMATION_STATE_WORDS.draft);
  } finally {
    await app.close();
  }
});
