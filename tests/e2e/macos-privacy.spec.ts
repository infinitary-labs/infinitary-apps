import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PRIVACY_WORDS } from "../../src/core/privacy/appDataWatch";
import { standInPrivacyLog } from "../helpers/privacyLogStandIn";
import { crewRoster } from "./crewRoster";
import { launchApp } from "./launch";
import { expandDock, restOnRow, rowSummary, taskFact } from "./rails";

/**
 * INF-1217, direction A (the captain chose "Build A: fewer searches,
 * explain and record"): when a crewmate's search makes macOS ask about
 * other apps' data, the task shows it waits on macOS until the question
 * is answered, and its record keeps both lines (docs/macos-privacy.md).
 *
 * Data: one live crewmate with its working copy, and macOS's own privacy
 * log lines from a real whole-disk search, printed by a stand-in log
 * reader from inside that working copy. The completion signal is the
 * task's Now line. It needs macOS's own `ps` and `lsof`, which find the
 * task; it shares nothing with another journey.
 */
test.skip(process.platform !== "darwin", "the privacy log and the dialog are macOS's");

test("a crewmate's search that macOS asks about shows the task waiting on macOS, then its answer", async () => {
  const fixture = await crewRoster(1, {
    idPrefix: "privacy-crew",
    title: () => "Find the retained archive",
    note: () => "Searching for the retained archive.",
  });
  const log = standInPrivacyLog();
  const app = await launchApp({
    ...fixture,
    withMockProvider: true,
    env: { ...fixture.env, INFINITARY_PRIVACY_LOG: log.program },
  });
  try {
    const { page } = app;
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const task = board.tasks.find((row) => row.id === "privacy-crew-0");
    if (!task) throw new Error("The seeded crewmate's task is missing");
    await expandDock(page, "now");

    await test.step("macOS asks: the task waits on macOS", async () => {
      await log.ask(join(fixture.userDataDir, "crew", "0"));
      await restOnRow(page, task.key);
      const summary = rowSummary(page).locator("[data-crew-summary]");
      await expect(taskFact(summary, "now")).toHaveText(PRIVACY_WORDS.waiting);
    });

    await test.step("the captain answers: the task says so and goes on", async () => {
      await log.answer("refused");
      // The summary the pointer rests on follows the task's record.
      const summary = rowSummary(page).locator("[data-crew-summary]");
      await expect(taskFact(summary, "now")).toHaveText(PRIVACY_WORDS.answered.refused);
      const detail = await page.evaluate(
        (id) => window.infinitary.tasks.detail(id),
        "privacy-crew-0",
      );
      const lines = detail.events.map((event: { text: string }) => event.text);
      expect(lines).toEqual(
        expect.arrayContaining([PRIVACY_WORDS.waiting, PRIVACY_WORDS.answered.refused]),
      );
    });
  } finally {
    await app.close();
  }
});
