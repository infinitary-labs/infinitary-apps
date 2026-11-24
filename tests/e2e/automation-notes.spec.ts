import { expect, test } from "@playwright/test";
import { automationWords, Scheduler } from "../../src/core/orchestrator/scheduler";
import { openDatabase } from "../../src/core/storage/db";
import { ScheduleStore } from "../../src/core/storage/scheduleStore";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { feedLineOf } from "./rails";
import { settingsSection } from "./settings";
import { focusOn, pressKey, typeInto } from "./windowKeys";

/**
 * A rule's notes in Settings → Automation, by keys (docs/automation.md, "A
 * rule's notes"; docs/keyboard.md, "A new feature"). The captain's ask: every
 * automation rule keeps limited-size learning notes that its runs change, so
 * later runs are faster; the captain reads, edits and clears them.
 *
 * - Promised result: the Notes tab shows the page a crewmate wrote; edited and
 *   saved by keys it becomes the next version; Earlier versions opens by
 *   Enter and lists both versions with who wrote each; Clear notes by Enter
 *   saves an empty version and the field empties; each save leaves one
 *   Activity line naming the captain.
 * - Data: one daily rule saved through the core's own `Scheduler` before the
 *   launch, with a crewmate's notes page as its first version.
 * - Completion signal: each Activity line, by the Scheduler's own words and
 *   the captain as actor; the versions Earlier versions lists.
 * - Platform prerequisites: none beyond the hermetic launcher.
 * - Shared resources: none; its own userData and HOME.
 */

const AUDIT = "Nightly session audit";
const LEARNED =
  "- 2026-11-12: The audit reads sessions from the app's own record; the folder scan finds nothing.";
const ADDED = "- 2026-11-13: Memory warnings are already filed; do not file them again.";

/** Who wrote a version, as Earlier versions ends its line: the words after its date. */
function writer(words: (values: { version: string; date: string }) => string): string {
  return words({ version: "", date: "\u0000" }).split("\u0000")[1] ?? "";
}

test("a rule's notes are edited, saved, read back and cleared in Settings by keys", async () => {
  const userDataDir = scratchDir("infinitary-automation-notes-");
  const db = openDatabase(userDataDir);
  const scheduler = new Scheduler({
    store: new ScheduleStore(db),
    notify: () => null,
    broadcastEvent: () => {},
  });
  const rule = scheduler.create(
    { kind: "daily", hour: 3, minute: 0, timeZone: "America/Los_Angeles" },
    "Audit last night's crewmate sessions and file what went wrong.",
    true,
    AUDIT,
  );
  scheduler.saveNotes(rule.id, LEARNED, { by: "crewmate", taskId: "seeded-run" });
  db.close();
  const app = await launchApp({ userDataDir });
  try {
    const { page } = app;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Automation", exact: true }).click();
    const tab = settingsSection(page, "automation");
    await pressKey(
      tab.locator(`[data-automation-row="${rule.id}"]`).getByRole("button").first(),
      "Enter",
    );
    await pressKey(tab.locator('[data-automation-tab="notes"]'), "Enter");

    const field = tab.locator("#automation-notes");
    await expect(field).toHaveValue(LEARNED);
    await focusOn(field);
    await field.evaluate((node) => {
      const area = node as HTMLTextAreaElement;
      area.setSelectionRange(area.value.length, area.value.length);
    });
    await typeInto(field, `\n${ADDED}`);
    await page.keyboard.press("Tab");
    const save = tab.locator("[data-automation-notes-save]");
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(field).toHaveValue(`${LEARNED}\n${ADDED}`);
    await expect(save).toBeDisabled();

    const earlier = tab.locator("[data-automation-notes-earlier] summary");
    await pressKey(earlier, "Enter");
    const version = (n: number) => tab.locator(`[data-automation-notes-version="${n}"]`);
    await expect(version(2)).toContainText(`${LEARNED}\n${ADDED}`);
    await expect(version(2)).toContainText(writer(m.settingsAutomationNotesByYou));
    await expect(version(1)).toContainText(LEARNED);
    await expect(version(1)).toContainText(writer(m.settingsAutomationNotesByCrew));

    await pressKey(tab.locator("[data-automation-notes-clear]"), "Enter");
    await expect(field).toHaveValue("");
    await expect(version(3)).toContainText(m.settingsAutomationNotesEmpty());
    await expect(tab.locator("[data-automation-notes-version]")).toHaveCount(3);

    // Each save left one Activity line naming the captain, read once Settings
    // no longer covers the Activity panel.
    await page.keyboard.press("Escape");
    for (const cleared of [false, true]) {
      await expect(
        feedLineOf(page, {
          type: "personalized",
          text: automationWords.notes(rule, cleared),
          actor: "captain",
        }),
      ).toHaveCount(1);
    }
  } finally {
    await app.close();
  }
});
