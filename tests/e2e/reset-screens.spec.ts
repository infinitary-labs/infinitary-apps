import { existsSync, rmSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { RESET_MARK_SUFFIX } from "../../src/core/reset/mark";
import { openDatabase } from "../../src/core/storage/db";
import { SAVED_DATA_REFUSAL_TITLE } from "../../src/core/storage/savedDataCompatibility";
import * as m from "../../src/shared/i18n/messages.generated";
import { recordNewerMigration } from "../helpers/database";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { seedProtectedProfile } from "./savedDataFixtures";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { pressKeyEndingApp } from "./windowKeys";

/**
 * Reset Infinitary from the screens shown when Infinitary cannot open
 * (docs/reset.md, "Where a reset can start"; the captain's ask that a reset
 * "should make the app go back to the initial installed state no matter
 * what"): a folder a newer version wrote, and starts that keep stopping
 * before Infinitary started. Keep everything and a declined confirmation
 * change nothing; a confirmed reset quits, and the next start opens on the
 * welcome screen.
 */

const question = (page: Page) =>
  page.getByRole("heading", { name: m.settingsGeneralResetQuestion() });

async function askAndKeep(page: Page) {
  await page.getByRole("button", { name: m.settingsGeneralReset() }).click();
  await expect(question(page)).toBeVisible();
  await expect(page.getByRole("button", { name: m.settingsGeneralResetKeep() })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(question(page)).toHaveCount(0);
}

async function confirmReset(launched: LaunchedApp) {
  const exited = new Promise<void>((done) => launched.app.process().once("exit", () => done()));
  await launched.page.getByRole("button", { name: m.settingsGeneralReset() }).click();
  await expect(question(launched.page)).toBeVisible();
  await launched.page
    .locator("main[data-reset-question]")
    .getByRole("button", { name: m.settingsGeneralReset() })
    .click();
  await exited;
}

async function opensFresh(userDataDir: string, homeDir: string) {
  const relaunched = await launchApp({ userDataDir, homeDir });
  try {
    await expect(relaunched.page.locator('[data-first-run-gate="open"]')).toBeVisible({
      timeout: 20_000,
    });
    expect(existsSync(`${userDataDir}${RESET_MARK_SUFFIX}`)).toBe(false);
  } finally {
    await relaunched.close();
  }
}

test("the saved-data refusal resets Infinitary once the person confirms", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = scratchDir("reset-refusal-");
  const db = openDatabase(userDataDir);
  recordNewerMigration(db);
  db.close();
  seedProtectedProfile(userDataDir, false);
  const homeDir = scratchDir("reset-refusal-home-");
  const mark = `${userDataDir}${RESET_MARK_SUFFIX}`;
  // The system's own confirmation is a stand-in here, never a real prompt.
  const launched = await launchSecrets({ userDataDir, homeDir, shell: false });
  try {
    const { page, app } = launched;
    await expect(page.getByRole("heading", { name: SAVED_DATA_REFUSAL_TITLE })).toBeVisible();

    await test.step("Keep everything has focus, so Enter resets nothing", async () => {
      await askAndKeep(page);
      expect(existsSync(mark)).toBe(false);
    });

    await test.step("a declined confirmation goes back and says nothing was reset", async () => {
      await app.evaluate(() => {
        (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = false;
      });
      await page.getByRole("button", { name: m.settingsGeneralReset() }).click();
      await page
        .locator("main[data-reset-question]")
        .getByRole("button", { name: m.settingsGeneralReset() })
        .click();
      await expect(page.getByRole("status")).toHaveText(m.resetScreenKept());
      await expect(page.getByRole("heading", { name: SAVED_DATA_REFUSAL_TITLE })).toBeVisible();
      expect(existsSync(mark)).toBe(false);
    });

    await test.step("a confirmed reset quits and asks the next start to wipe the folder", async () => {
      await app.evaluate(() => {
        (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = true;
      });
      await confirmReset(launched);
      expect(existsSync(mark)).toBe(true);
    });
    await launched.close();

    await test.step("the next start opens on the welcome screen", async () => {
      await opensFresh(userDataDir, homeDir);
    });
  } finally {
    await launched.close();
  }
});

test("Infinitary could not start offers Try again and Reset Infinitary", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = scratchDir("reset-could-not-start-");
  const homeDir = scratchDir("reset-could-not-start-home-");
  const count = `${userDataDir}.start-attempts`;
  const opened: LaunchedApp[] = [];
  const stuck = async () => {
    // e2e-fixture: mutation -- two earlier starts that never got through.
    writeFileSync(count, "2\n");
    const launched = await launchApp({ userDataDir, homeDir, shell: false });
    opened.push(launched);
    await expect(
      launched.page.getByRole("heading", { name: m.resetCouldNotStartTitle() }),
    ).toBeVisible();
    return launched;
  };
  try {
    await test.step("Try again forgets the earlier starts and quits to start again", async () => {
      const launched = await stuck();
      const tryAgain = launched.page.getByRole("button", { name: m.resetHeldTryAgain() });
      await expect(tryAgain).toBeFocused();
      await pressKeyEndingApp(launched.app, tryAgain, "Enter");
      expect(existsSync(count)).toBe(false);
      await launched.close();
    });

    await test.step("Reset Infinitary asks first, then resets with no first mate running", async () => {
      const launched = await stuck();
      await askAndKeep(launched.page);
      // An isolated folder has no system confirmation, so the question alone confirms.
      await confirmReset(launched);
      expect(existsSync(`${userDataDir}${RESET_MARK_SUFFIX}`)).toBe(true);
      await launched.close();
    });

    await test.step("the next start forgets the earlier starts and opens on the welcome screen", async () => {
      await opensFresh(userDataDir, homeDir);
      expect(existsSync(count)).toBe(false);
    });
  } finally {
    for (const launched of opened) await launched.close();
    // e2e-fixture: mutation -- the count this journey wrote beside the folder, should a step fail.
    rmSync(count, { force: true });
  }
});
