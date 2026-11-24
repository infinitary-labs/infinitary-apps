import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { RESET_MARK_SUFFIX } from "../../src/core/reset/mark";
import { RUN_WORDS } from "../../src/main/runCommand";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { seedMockModelCatalog } from "./accountFixtures";
import { endCommands, run, runEnv } from "./commandRun";
import { builtAppDir, type LaunchedApp, launchApp } from "./launch";
import { mockModelsJson } from "./mockModels";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingRow } from "./settings";

/**
 * Reset Infinitary from a computer that controls a first mate started by a
 * command, with no window of its own (docs/reset.md, "A first mate with no
 * window"; the captain's ask that a reset "should make the app go back to the
 * initial installed state no matter what", and their answer on its review,
 * command_home=finish). Promised result: once the person confirms on the
 * controlling computer, the run takes the reset as a window would, then ends
 * with 0 and its own words, starting nothing again itself; the window opened
 * beside it is not ended with the leftovers and starts again by itself; that
 * start wipes the folder and opens on the welcome screen. Data: a throwaway
 * data folder for the run, the mock provider's model list, a second app with
 * disposable Secrets that joins it with a link, and a stand-in system
 * confirmation; an isolated window never starts itself again, so the
 * development build notes the start it asks for in a file and the journey
 * starts it. Completion: the run's lines and exit code, the window's noted
 * start, the reset mark beside each folder, and the welcome screen.
 */

const HOME = "Mac mini";

test.afterEach(endCommands);

/** The link another computer joins with, from the running first mate's own command. */
function linkOf(env: Record<string, string>): string {
  const asked = spawnSync(electronPath as unknown as string, [builtAppDir(), "link", "--json"], {
    env,
    cwd: scratchDir("reset-command-home-cwd-"),
    encoding: "utf8",
  });
  expect(asked.status, asked.stderr).toBe(0);
  return String((JSON.parse(asked.stdout) as { link: string }).link);
}

test("a computer that controls a first mate started by a command resets it, and the window beside it starts again as newly installed", async () => {
  test.setTimeout(4 * 60_000);
  const provider: MockProviderServer = await startMockProvider();
  const relaunchNote = join(scratchDir("reset-command-home-relaunch-"), "relaunch.json");
  const opened: LaunchedApp[] = [];
  const marks: string[] = [];
  try {
    const userDataDir = scratchDir("reset-command-home-");
    seedMockModelCatalog(userDataDir, mockModelsJson(provider.port));
    const env = await runEnv(userDataDir, {
      INFINITARY_DEVICE_NAME: HOME,
      INFINITARY_RELAUNCH_NOTE: relaunchNote,
    });
    const ran = run(env);
    await ran.started();
    const beside = await launchApp({
      userDataDir,
      env: { INFINITARY_RELAUNCH_NOTE: relaunchNote },
    });
    opened.push(beside);
    expect(await beside.page.evaluate(() => window.infinitary.devices.thisMac())).toEqual({
      role: "home",
      left: null,
      byCommand: true,
    });

    const studio = await launchSecrets({ env: { INFINITARY_DEVICE_NAME: "Studio" } });
    opened.push(studio);
    const link = linkOf(env);
    // Joining starts the window over, so its answer may never return to this page.
    await studio.page.evaluate((joined) => {
      void window.infinitary.devices.join(joined);
    }, link);
    await expect(studio.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
      { timeout: 30_000 },
    );
    marks.push(...[userDataDir, studio.userDataDir].map((dir) => `${dir}${RESET_MARK_SUFFIX}`));

    await test.step("a confirmed reset there ends the run here, which starts nothing again", async () => {
      const besideEnded = new Promise<void>((done) =>
        beside.app.process().once("exit", () => done()),
      );
      const studioEnded = new Promise<void>((done) =>
        studio.app.process().once("exit", () => done()),
      );
      await studio.app.evaluate((_electron) => {
        (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = true;
      });
      await studio.page.getByRole("button", { name: "Settings" }).click();
      const row = settingRow(studio.page, "reset-infinitary");
      await row.getByRole("button", { name: m.settingsGeneralResetButton(), exact: true }).click();
      await expect(row.locator("[data-reset-question]")).toContainText(
        m.settingsGeneralResetQuestionBoth({ home: HOME }),
      );
      await row.getByRole("button", { name: m.settingsGeneralReset(), exact: true }).click();
      expect(await ran.exited, ran.error()).toBe(0);
      expect(ran.lines()).toContain(RUN_WORDS.reset());
      await studioEnded;
      for (const mark of marks) expect(existsSync(mark)).toBe(true);

      // The window beside the run is no leftover of it: it starts again by itself, as a window.
      await besideEnded;
      const asked = JSON.parse(readFileSync(relaunchNote, "utf8")) as string[];
      expect(asked).not.toContain("run");
      expect(asked).toContain(builtAppDir());
    });

    await test.step("the window's next start wipes the folder and opens on the welcome screen", async () => {
      const again = await launchApp({ userDataDir });
      opened.push(again);
      await expect(again.page.locator('[data-first-run-gate="open"]')).toBeVisible({
        timeout: 30_000,
      });
      expect(existsSync(marks[0] as string)).toBe(false);
      expect(await again.page.evaluate(() => window.infinitary.devices.thisMac())).toMatchObject({
        role: "home",
      });
    });
  } finally {
    for (const app of opened.reverse()) await app.close();
    await provider.close();
    // The studio's next start would finish its own reset; this journey starts none.
    for (const mark of marks.slice(1)) rmSync(mark, { force: true });
  }
});
