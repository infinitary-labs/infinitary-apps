import { existsSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { RESET_MARK_SUFFIX } from "../../src/core/reset/mark";
import * as m from "../../src/shared/i18n/messages.generated";
import type { LaunchedApp } from "./launch";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingRow } from "./settings";

/**
 * Reset Infinitary from a computer that controls the first mate
 * (docs/reset.md, "From a computer that controls the first mate"; the
 * captain's ask that a reset "should make the app go back to the initial
 * installed state no matter what", started from Settings on a computer that
 * controls the first mate). A declined confirmation there changes nothing on
 * either computer; a confirmed one resets the first mate's computer, then
 * this one, and each next start wipes its folder.
 */

const HOME = "Mac mini";

test("a computer that controls the first mate resets both computers once the person confirms", async () => {
  test.setTimeout(3 * 60_000);
  const opened: LaunchedApp[] = [];
  const marks: string[] = [];
  try {
    // Each system confirmation is a stand-in here, never a real prompt.
    const home = await launchSecrets({ env: { INFINITARY_DEVICE_NAME: HOME } });
    opened.push(home);
    const invite = await home.page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "mac" }),
    );
    const studio = await launchSecrets({ env: { INFINITARY_DEVICE_NAME: "Studio" } });
    opened.push(studio);
    // Joining starts the window over, so its answer may never return to this page.
    await studio.page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(studio.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
    );
    marks.push(...[home, studio].map((app) => `${app.userDataDir}${RESET_MARK_SUFFIX}`));
    await studio.page.getByRole("button", { name: "Settings" }).click();
    const row = settingRow(studio.page, "reset-infinitary");
    await expect(row).toContainText(m.settingsGeneralResetDescriptionBoth({ home: HOME }));
    const resetButton = () =>
      row.getByRole("button", { name: m.settingsGeneralResetButton(), exact: true });
    const confirm = async (yes: boolean) => {
      await studio.app.evaluate((_electron, value) => {
        (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = value;
      }, yes);
      await resetButton().click();
      await expect(row.locator("[data-reset-question]")).toContainText(
        m.settingsGeneralResetQuestionBoth({ home: HOME }),
      );
      await row.getByRole("button", { name: m.settingsGeneralReset(), exact: true }).click();
    };

    await test.step("a declined confirmation resets neither computer", async () => {
      await confirm(false);
      await expect(row.locator("[data-reset-question]")).toHaveCount(0);
      await expect(resetButton()).toBeFocused();
      for (const mark of marks) expect(existsSync(mark)).toBe(false);
    });

    await test.step("a confirmed reset resets the first mate's computer, then this one", async () => {
      const exits = [home, studio].map(
        (app) => new Promise<void>((done) => app.app.process().once("exit", () => done())),
      );
      await confirm(true);
      await Promise.all(exits);
      for (const mark of marks) expect(existsSync(mark)).toBe(true);
    });
  } finally {
    for (const app of opened.reverse()) await app.close();
    // The next start would finish each reset and take its mark; this journey starts none
    // (reset-infinitary.spec.ts owns that start).
    for (const mark of marks) rmSync(mark, { force: true });
  }
});
