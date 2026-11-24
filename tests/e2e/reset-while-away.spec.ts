import { existsSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { RESET_MARK_SUFFIX } from "../../src/core/reset/mark";
import { RESET_REMOVALS_SUFFIX } from "../../src/core/reset/removals";
import { feedLineFrom } from "../../src/shared/feed";
import * as m from "../../src/shared/i18n/messages.generated";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow, slidePointer } from "./layout";
import { heroShot } from "./pictures";
import { activityFrame, atRest, expandDock } from "./rails";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingRow } from "./settings";

/**
 * A computer out of reach when the first mate was reset (docs/reset.md,
 * "Computers out of reach"; the captain's ask that a reset "should make the
 * app go back to the initial installed state no matter what"): a computer
 * that controls the first mate is closed while the first mate's computer
 * resets, so it cannot hear it was removed then. Once the fresh first mate
 * starts and that computer opens again, it hears it was removed and is its
 * own first mate again, saying so, and the fresh first mate says once on the
 * feed that it removed it, with the record beside its folder gone.
 */

const HOME = "Mac mini";
const STUDIO = "Studio";

test("a computer closed during a reset hears it was removed once it opens again", async () => {
  test.setTimeout(4 * 60_000);
  const opened: LaunchedApp[] = [];
  let leftover: string[] = [];
  try {
    // Each system confirmation is a stand-in here, never a real prompt.
    const home = await launchSecrets({ env: { INFINITARY_DEVICE_NAME: HOME } });
    opened.push(home);
    const record = `${home.userDataDir}${RESET_REMOVALS_SUFFIX}`;
    leftover = [`${home.userDataDir}${RESET_MARK_SUFFIX}`, record];
    const invite = await home.page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "mac" }),
    );
    const studio = await launchSecrets({ env: { INFINITARY_DEVICE_NAME: STUDIO } });
    opened.push(studio);
    // Joining starts the window over, so its answer may never return to this page.
    await studio.page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(studio.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
    );
    const studioId = (await home.page.evaluate(() => window.infinitary.devices.list())).find(
      (device) => device.name === STUDIO,
    )?.id;
    expect(studioId).toBeDefined();

    await test.step("the first mate resets while the computer that controls it is closed", async () => {
      await studio.close();
      await expect
        .poll(async () =>
          (await home.page.evaluate(() => window.infinitary.devices.list())).some(
            (device) => device.name === STUDIO && device.controlling,
          ),
        )
        .toBe(false);
      await home.app.evaluate(() => {
        (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = true;
      });
      const exited = new Promise<void>((done) => home.app.process().once("exit", () => done()));
      await home.page.getByRole("button", { name: "Settings" }).click();
      const row = settingRow(home.page, "reset-infinitary");
      await row.getByRole("button", { name: m.settingsGeneralResetButton(), exact: true }).click();
      await row.getByRole("button", { name: m.settingsGeneralReset(), exact: true }).click();
      await exited;
      expect(existsSync(record)).toBe(true);
    });

    const fresh = await launchApp({
      userDataDir: home.userDataDir,
      homeDir: home.homeDir,
      gpuBenchmarking: true,
    });
    opened.push(fresh);
    await expect(fresh.page.locator('[data-first-run-gate="open"]')).toBeVisible({
      timeout: 30_000,
    });

    await test.step("the computer opens again and hears it was removed", async () => {
      const back = await launchSecrets({
        userDataDir: studio.userDataDir,
        homeDir: studio.homeDir,
        env: { INFINITARY_DEVICE_NAME: STUDIO },
      });
      opened.push(back);
      // It had its own first mate before it joined, which it is again.
      await expect
        .poll(() => back.page.evaluate(() => window.infinitary.devices.thisMac()), {
          timeout: 60_000,
        })
        .toMatchObject({ role: "home", left: { name: HOME, reason: "removed" } });
    });

    await test.step("the fresh first mate says once that it removed it, and keeps no record", async () => {
      const said = feedLineFrom({
        type: "device_reset_removal",
        deviceId: studioId ?? "",
        name: STUDIO,
        outcome: "removed",
      })?.text;
      expect(said).toBeDefined();
      const lines = async () =>
        (await fresh.page.evaluate(() => window.infinitary.feed.recent())).map((line) => line.text);
      await expect.poll(lines, { timeout: 90_000 }).toContain(said);
      expect((await lines()).filter((line) => line === said)).toHaveLength(1);
      expect(existsSync(record)).toBe(false);
      // The whole line, as resting on it shows it beside Activity.
      const { page } = fresh;
      await resizeWindow(fresh.app, page, { width: 1280, height: 800 });
      await expandDock(page, "activity");
      const row = activityFrame(page)
        .locator("[data-feed-row]")
        .filter({ hasText: said ?? "" });
      const summary = page.locator("[data-line-summary]:not([aria-hidden])");
      const rest = async () => {
        await atRest(page, row);
        const box = await row.locator("[data-feed-line]").boundingBox();
        if (!box) throw new Error("The Activity line is not drawn");
        const at = { x: box.x + box.width - 2, y: box.y + box.height / 2 };
        await slidePointer(page, at, at, 1);
        await expect(summary.locator("[data-line-summary-text]")).toHaveText(said ?? "");
      };
      await rest();
      await heroShot(fresh.app, page, {
        region: summary.getByRole("status"),
        anchors: [row],
        name: "reset-out-of-reach-removed",
        dir: test.info().outputPath("hero"),
        ready: rest,
      });
    });
  } finally {
    for (const app of opened.reverse()) await app.close();
    for (const file of leftover) rmSync(file, { force: true });
  }
});
