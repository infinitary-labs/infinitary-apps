import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { RESET_MARK_SUFFIX, RESETTING_SUFFIX } from "../../src/core/reset/mark";
import * as m from "../../src/shared/i18n/messages.generated";
import { launchApp } from "./launch";
import { settingRow } from "./settings";

/**
 * Reset Infinitary (docs/reset.md; the captain's ask that a reset button in
 * Settings "should make the app go back to the initial installed state no
 * matter what"): Keep everything changes nothing, and Reset Infinitary quits
 * the app, whose next start wipes its folder and opens on the welcome screen.
 * The second start carries an environment provider key, which must not hide
 * the sign-in screen the reset leads to.
 */

const SENTINEL = "left-from-before-the-reset.txt";

function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function openGeneral(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(settingRow(page, "reset-infinitary")).toBeVisible();
}

test("Reset Infinitary keeps everything on Keep everything, and otherwise opens fresh on the welcome screen", async () => {
  const launched = await launchApp({ withMockProvider: true });
  const { page, userDataDir, homeDir } = launched;
  const mark = `${userDataDir}${RESET_MARK_SUFFIX}`;
  // e2e-fixture: mutation -- prove the reset deletes what the folder held.
  writeFileSync(join(userDataDir, SENTINEL), "saved work\n");
  // A job a task kept running past its close: the reset runs its own remove
  // before quitting, which shows the first mate's side undid its work first.
  const outside = mkdtempSync(join(tmpdir(), "reset-kept-"));
  const keptFolder = join(outside, "job");
  const removed = join(outside, "removed");
  mkdirSync(keptFolder);
  mkdirSync(join(userDataDir, "kept"), { recursive: true });
  // e2e-fixture: mutation -- prove the reset runs a kept job's remove before it quits.
  writeFileSync(
    join(userDataDir, "kept", "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          computer: null,
          account: "",
          label: "nightly backup",
          check: "true",
          remove: `touch '${removed}'`,
          folder: keptFolder,
          task: "t-kept",
          key: "INF-1",
          at: 1,
        },
      ],
    }),
  );
  const homeBefore = listing(homeDir);
  let relaunched: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await openGeneral(page);
    const row = settingRow(page, "reset-infinitary");
    // Each row says what it keeps: Purge keeps projects, sign-ins and
    // settings; the reset's question points at Purge for tasks only.
    const { knowledge } = await page.evaluate(() => window.infinitary.retention.scope());
    await expect(settingRow(page, "purge-task-data")).toContainText(
      knowledge
        ? m.settingsGeneralPurgeDescriptionKnowledge()
        : m.settingsGeneralPurgeDescription(),
    );

    await test.step("Keep everything has focus, so Enter resets nothing", async () => {
      await row.getByRole("button", { name: m.settingsGeneralResetButton(), exact: true }).click();
      await expect(row.locator("[data-reset-question]")).toContainText(
        m.settingsGeneralResetKeeps(),
      );
      const keep = row.getByRole("button", { name: m.settingsGeneralResetKeep(), exact: true });
      await expect(keep).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(row.locator("[data-reset-question]")).toHaveCount(0);
      await expect(
        row.getByRole("button", { name: m.settingsGeneralResetButton(), exact: true }),
      ).toBeFocused();
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(join(userDataDir, SENTINEL))).toBe(true);
    });

    await test.step("Reset Infinitary quits the app and asks its next start to wipe the folder", async () => {
      const exited = new Promise<void>((done) => launched.app.process().once("exit", () => done()));
      await row.getByRole("button", { name: m.settingsGeneralResetButton(), exact: true }).click();
      await row.getByRole("button", { name: m.settingsGeneralReset(), exact: true }).click();
      await exited;
      expect(existsSync(mark)).toBe(true);
      expect(existsSync(removed)).toBe(true);
      // An isolated run reaches nothing outside its own folder.
      expect(listing(homeDir)).toEqual(homeBefore);
    });
    await launched.close();

    await test.step("the next start opens on the welcome screen with nothing kept", async () => {
      relaunched = await launchApp({
        userDataDir,
        homeDir,
        env: { OPENAI_API_KEY: "sk-reset-journey" },
      });
      await expect(relaunched.page.locator('[data-first-run-gate="open"]')).toBeVisible({
        timeout: 20_000,
      });
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(join(userDataDir, SENTINEL))).toBe(false);
      const aside = `${basename(userDataDir)}${RESETTING_SUFFIX}`;
      expect(listing(dirname(userDataDir)).filter((name) => name.startsWith(aside))).toEqual([]);
    });
  } finally {
    await relaunched?.close();
    await launched.close();
    rmSync(outside, { recursive: true, force: true });
  }
});
