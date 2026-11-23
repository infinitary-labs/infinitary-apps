import { expect, test } from "@playwright/test";
import { homebrewInstallationReceipt } from "../../src/core/update/macInstallation";
import { INFINITARY_TAP, upgradeCommandFor } from "../../src/core/update/updateChannels";
import {
  UPDATE_LATER,
  UPDATE_NOTICES,
  UPDATE_PROBLEMS,
  UPDATE_STEP_WORDS,
  UPDATE_WORDS,
  UPDATE_WORK_WORDS,
} from "../../src/shared/updateWords";
import { startDemo } from "./demo";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { arrangeMacUpdates } from "./macUpdateFixture";
import { heroShot, regionShot } from "./pictures";
import { setThemeViaSettings } from "./theme";
import { focusOn, pressKey, runFromSearch, untilFocused } from "./windowKeys";

const STABLE_TARGET = "0.5.0";

// INF-640: keyboard channel selection, persisted membership and consent/progress/error UI.
// Fixture: real source app/controller, isolated HOME/userData and native effects stood in.
// Completion: persisted channel after restart, cancellation before replacement, and visible failure recovery.
// No signing, installed-app replacement, shared account, native focus or real download is exercised here.
test("a saved channel survives restart and stable never downgrades an ahead alpha", async () => {
  let launched = await launchApp({ withMockProvider: true });
  const root = launched.userDataDir;
  try {
    await arrangeMacUpdates(launched, "0.5.1-alpha.9", { stable: STABLE_TARGET });
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    const choice = page.getByRole("radiogroup", { name: UPDATE_WORDS.channel });
    await pressKey(choice.getByRole("radio", { name: "Alpha", exact: true }), "ArrowLeft");
    await expect(choice.getByRole("radio", { name: "Stable", exact: true })).toBeChecked();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.update.status()))
      .toMatchObject({ channel: "stable", updateAvailable: false, latestVersion: STABLE_TARGET });
    for (const theme of ["dark", "light"] as const) {
      await setThemeViaSettings(page, theme, { close: false });
      await regionShot(
        page.locator('[data-setting="update-channel"]'),
        test.info().outputPath(`channel-${theme}.png`),
      );
    }
    await launched.close();
    launched = await launchApp({ withMockProvider: true, userDataDir: root });
    await arrangeMacUpdates(launched, "0.5.1-alpha.9", { stable: STABLE_TARGET });
    expect(await launched.page.evaluate(() => window.infinitary.update.status())).toMatchObject({
      channel: "stable",
      updateAvailable: false,
    });
    expect(await launched.app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
  } finally {
    await launched.close();
  }
});

// INF-2670, the captain's answer: a failure the app cannot fix here withdraws Update and
// restart, and Open the releases page becomes the next step.
test("update consent exposes progress, and an installation error offers the releases page", async () => {
  const demo = await startDemo({ withMockProvider: true, size: { width: 1280, height: 800 } });
  const { page, app } = demo.launched;
  const failure = UPDATE_PROBLEMS.unwritable;
  try {
    await arrangeMacUpdates(demo.launched, "0.5.0-alpha.9");
    const indicator = page.getByRole("button", { name: /Update available/ });
    await pressKey(indicator, "Enter");
    const panel = page.locator("[data-update-channel]");
    await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toBeVisible();
    expect(await app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(0);
    await regionShot(panel, test.info().outputPath("update-offer-dark.png"));
    // A transparent crop marker keeps the growing popup whole, without changing what is drawn.
    await page.evaluate(() => {
      const crop = document.createElement("div");
      crop.dataset.updateCapture = "";
      Object.assign(crop.style, {
        position: "fixed",
        top: "0",
        right: "0",
        width: "440px",
        height: "380px",
        pointerEvents: "none",
      });
      document.body.append(crop);
    });
    await demo.record(
      "Request an update, read download progress, then recover from a refused installation",
      page.locator("[data-update-capture]"),
      async () => {
        await demo.step(async () => {
          await pressKey(panel.getByRole("button", { name: UPDATE_WORDS.restart }), "Enter");
          await expect
            .poll(() => app.evaluate(() => globalThis.__macUpdateFixture.downloads))
            .toBe(1);
          await app.evaluate(() => globalThis.__macUpdateFixture.progress(42));
          await expect(
            panel.getByRole("progressbar", { name: UPDATE_WORDS.progress }),
          ).toHaveAttribute("value", "42");
        });
        await regionShot(panel, test.info().outputPath("update-progress-dark.png"));
        await demo.step(async () => {
          await app.evaluate((_, text) => globalThis.__macUpdateFixture.fail(text), failure);
          await expect(panel.getByRole("alert")).toHaveText(failure);
        });
        expect(await app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
        await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toHaveCount(0);
        await regionShot(panel, test.info().outputPath("update-error-dark.png"));
        await demo.step(async () => {
          await pressKey(panel.getByRole("button", { name: UPDATE_WORDS.releasesPage }), "Enter");
          await expect
            .poll(() => app.evaluate(() => globalThis.__macUpdateFixture.opened.length))
            .toBe(1);
        });
      },
    );
    await demo.finish({
      dir: test.info().outputPath("demo"),
      name: "update-progress-error",
      poster: "last",
    });
  } finally {
    await demo.launched.close();
  }
});

test("switching channels cancels a pending download without installing it", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    await arrangeMacUpdates(launched, "0.5.0-alpha.9", { stable: STABLE_TARGET });
    const { page, app } = launched;
    await pressKey(page.getByRole("button", { name: /Update available/ }), "Enter");
    await pressKey(page.getByRole("button", { name: UPDATE_WORDS.restart }), "Enter");
    await expect.poll(() => app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    const group = page.getByRole("radiogroup", { name: UPDATE_WORDS.channel });
    await pressKey(group.getByRole("radio", { name: "Alpha", exact: true }), "ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => window.infinitary.update.status()))
      .toMatchObject({ channel: "stable", latestVersion: STABLE_TARGET, phase: "idle" });
    expect(await app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
    await page.keyboard.press("Escape");
    await pressKey(page.getByRole("button", { name: /Update available/ }), "Enter");
    await expect(page.locator("[data-update-channel]")).toHaveAttribute(
      "data-update-channel",
      "stable",
    );
    await expect(page.locator("[data-update-channel]").getByRole("alert")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

test("a direct stable installation offers keyboard update consent", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    await resizeWindow(launched.app, launched.page, { width: 1280, height: 800 });
    // The same version, viewport, themes and popup region as the pre-change photographs.
    await arrangeMacUpdates(launched, "0.1.30", { stable: "0.1.31" });
    for (const theme of ["dark", "light"] as const) {
      await setThemeViaSettings(launched.page, theme);
      await runFromSearch(launched.app, launched.page, "updates.show");
      const panel = launched.page.locator("[data-update-channel]");
      // INF-3405, the captain's direction B: Check for updates comes first, then the next step.
      await expect(panel.getByRole("button", { name: UPDATE_WORDS.check })).toBeFocused();
      await launched.page.keyboard.press("Tab");
      await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toBeFocused();
      expect(await launched.app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(0);
      await regionShot(panel, test.info().outputPath(`update-after-${theme}.png`));
      if (theme === "dark")
        await heroShot(launched.app, launched.page, {
          region: panel,
          name: "mac-installer-updates",
        });
      await launched.page.keyboard.press("Escape");
      await launched.page.getByRole("button", { name: "Settings", exact: true }).click();
      await launched.page.getByRole("tab", { name: "General", exact: true }).click();
      await regionShot(
        launched.page.locator('[data-setting="version"]').locator(".."),
        test.info().outputPath(`version-after-${theme}.png`),
      );
      await launched.page.keyboard.press("Escape");
    }
  } finally {
    await launched.close();
  }
});

test("a staged update offers a keyboard restart retry and locks channel changes", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page, app } = launched;
    await resizeWindow(app, page, { width: 1280, height: 800 });
    await arrangeMacUpdates(launched, "0.5.0-alpha.9");
    await app.evaluate(() => {
      globalThis.__macUpdateFixture.failRestart = true;
    });
    await pressKey(page.getByRole("button", { name: /Update available/ }), "Enter");
    const panel = page.locator("[data-update-channel]");
    await pressKey(panel.getByRole("button", { name: UPDATE_WORDS.restart }), "Enter");
    await expect.poll(() => app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(1);
    await app.evaluate(() => globalThis.__macUpdateFixture.finish());
    await expect(
      panel.getByRole("button", { name: UPDATE_WORDS.ready, exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveText(UPDATE_PROBLEMS.staged);
    await regionShot(panel, test.info().outputPath("update-ready-dark.png"));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    const choice = page.getByRole("radiogroup", { name: UPDATE_WORDS.channel });
    for (const name of ["Stable", "Alpha"])
      await expect(choice.getByRole("radio", { name, exact: true })).toBeDisabled();
    // INF-2670: the Version row offers the same Restart; the channel row keeps only its own problem.
    const version = page.locator('[data-setting="version"]');
    await expect(version.locator("[data-update-line]")).toHaveText(UPDATE_PROBLEMS.staged);
    await expect(
      version.getByRole("button", { name: UPDATE_WORDS.ready, exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-setting="update-channel"]')).not.toContainText(
      UPDATE_PROBLEMS.staged,
    );
    await regionShot(
      page.locator('[data-setting="update-channel"]'),
      test.info().outputPath("channel-ready-dark.png"),
    );
    await page.keyboard.press("Escape");
    await app.evaluate(() => {
      globalThis.__macUpdateFixture.failRestart = false;
    });
    await pressKey(page.getByRole("button", { name: /Update available/ }), "Enter");
    await pressKey(panel.getByRole("button", { name: UPDATE_WORDS.ready, exact: true }), "Enter");
    await expect
      .poll(() => app.evaluate(() => globalThis.__macUpdateFixture.installations))
      .toBe(2);
  } finally {
    await launched.close();
  }
});

// INF-2245 (INF-2223's approved stop-and-resume update): before the copy is
// replaced, the update saves the crew's work and names whose running work it
// waits for; Update later, by Tab or by command search, lets it go with
// nothing installed, and a saved update goes on to Updating.
// Fixture: the real update controller, IPC, panel and Version row, with the
// crew's work and native replacement stood in (tests/fixtures/mac-updates).
// Completion: the stand-in's saves and installations, and the panel's words.
test("an update saves running work first, and Update later installs nothing, by keys", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page, app } = launched;
    await resizeWindow(app, page, { width: 1280, height: 800 });
    await arrangeMacUpdates(launched, "0.1.30", { stable: "0.1.31" });
    await app.evaluate(() => {
      globalThis.__macUpdateFixture.holdSave = true;
      globalThis.__macUpdateFixture.waitingFor = ["Release notes"];
    });
    const panel = page.locator("[data-update-channel]");
    const fixture = <K extends "downloads" | "saves" | "installations">(key: K) =>
      app.evaluate((_, name) => globalThis.__macUpdateFixture[name], key);
    const update = async (downloads: number) => {
      if (!(await panel.isVisible())) await runFromSearch(app, page, "updates.show");
      await pressKey(panel.getByRole("button", { name: UPDATE_WORDS.restart }), "Enter");
      await expect.poll(() => fixture("downloads")).toBe(downloads);
      await app.evaluate(() => globalThis.__macUpdateFixture.finish());
    };

    await update(1);
    await expect(panel.locator("[data-update-line]")).toHaveText(UPDATE_WORK_WORDS.saving);
    await expect(panel.locator("[data-update-waiting]")).toHaveText(
      UPDATE_WORK_WORDS.waitingFor("Release notes"),
    );
    await regionShot(panel, test.info().outputPath("update-saving-dark.png"));

    await focusOn(page.getByRole("button", { name: /Update available/ }));
    await page.keyboard.press("Tab");
    await untilFocused(panel.getByRole("button", { name: UPDATE_WORDS.later }));
    await page.keyboard.press("Enter");
    await expect(panel.locator("[data-update-line]")).toContainText(UPDATE_LATER);
    await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toBeEnabled();
    expect(await fixture("installations")).toBe(0);
    await regionShot(panel, test.info().outputPath("update-later-dark.png"));

    // Update later from command search lets the next save go too.
    await update(2);
    await expect(panel.locator("[data-update-waiting]")).toBeVisible();
    await runFromSearch(app, page, "updates.later");
    await expect.poll(() => fixture("saves")).toBe(2);
    await runFromSearch(app, page, "updates.show");
    await expect(panel.locator("[data-update-line]")).toContainText(UPDATE_LATER);
    expect(await fixture("installations")).toBe(0);

    await update(3);
    await expect(panel.locator("[data-update-waiting]")).toBeVisible();
    await app.evaluate(() => globalThis.__macUpdateFixture.saved());
    await expect.poll(() => fixture("installations")).toBe(1);
    await expect(panel.locator("[data-update-line]")).toHaveText(UPDATE_WORK_WORDS.updating);
    await expect(panel.locator("[data-update-waiting]")).toHaveCount(0);
    await regionShot(panel, test.info().outputPath("update-updating-dark.png"));
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    const version = page.locator('[data-setting="version"]').locator("..");
    await expect(version).toContainText(UPDATE_WORK_WORDS.updating);
    await regionShot(version, test.info().outputPath("version-updating-dark.png"));
  } finally {
    await launched.close();
  }
});

// Captain's revised INF-643: Homebrew remains supported and must never use native replacement.
// The real controller/IPC/rendered notice choose from a cask-produced receipt; effects are stood in.
// INF-2670, the captain's answer: the command shows in the Version row and the notice, with Copy
// command, which hands the page's clipboard the command (stood in, never the Mac's own clipboard).
test("a Homebrew installation keeps its upgrade command and never offers native update consent", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 800 });
    await arrangeMacUpdates(
      launched,
      "0.1.30",
      { stable: "0.1.31" },
      homebrewInstallationReceipt("stable", INFINITARY_TAP),
    );
    for (const theme of ["dark", "light"] as const) {
      await setThemeViaSettings(page, theme);
      await runFromSearch(app, page, "updates.show");
      const panel = page.locator("[data-update-channel]");
      const command = upgradeCommandFor("stable", INFINITARY_TAP);
      await expect(panel.getByText(command, { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toHaveCount(0);
      await page.evaluate(() => {
        const copied: string[] = [];
        (globalThis as { __copied?: string[] }).__copied = copied;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => void copied.push(text) },
        });
      });
      await pressKey(panel.getByRole("button", { name: UPDATE_WORDS.copy }), "Enter");
      await expect(panel.getByRole("button", { name: UPDATE_WORDS.copied })).toBeVisible();
      expect(await page.evaluate(() => (globalThis as { __copied?: string[] }).__copied)).toEqual([
        command,
      ]);
      expect((await page.evaluate(() => window.infinitary.update.install())).ok).toBe(false);
      expect(await app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(0);
      expect(await app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
      await regionShot(panel, test.info().outputPath(`homebrew-update-${theme}.png`));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "General", exact: true }).click();
      await expect(page.getByRole("radiogroup", { name: UPDATE_WORDS.channel })).toHaveCount(0);
      const version = page.locator('[data-setting="version"]');
      await expect(version.getByText(command, { exact: true })).toBeVisible();
      await expect(version.getByRole("button", { name: UPDATE_WORDS.copy })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  } finally {
    await launched.close();
  }
});

test("unknown installation ownership explains the refusal without offering replacement", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page, app } = launched;
    await resizeWindow(app, page, { width: 1280, height: 800 });
    await arrangeMacUpdates(launched, "0.1.30", { stable: "0.1.31" }, "");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    await expect(
      page.getByText(UPDATE_PROBLEMS.unknownInstallation, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: UPDATE_WORDS.channel })).toHaveCount(0);
    expect((await page.evaluate(() => window.infinitary.update.install())).ok).toBe(false);
    expect(await app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
    // INF-2670: the explanation sits beside the button that opens the releases page.
    await pressKey(
      page
        .locator('[data-setting="version"]')
        .getByRole("button", { name: UPDATE_WORDS.releasesPage }),
      "Enter",
    );
    await expect
      .poll(() => app.evaluate(() => globalThis.__macUpdateFixture.opened.length))
      .toBe(1);
    for (const theme of ["dark", "light"] as const) {
      await setThemeViaSettings(page, theme, { close: false });
      await regionShot(
        page.locator('[data-setting="version"]').locator(".."),
        test.info().outputPath(`unknown-installation-${theme}.png`),
      );
    }
  } finally {
    await launched.close();
  }
});

// INF-2073, the captain's direction A: Check for updates in Settings → General and command search,
// reading the feed past the 4-hour saved answer. The feed and native effects are stood in.
// INF-2670, the captain's direction A: the row's button is always the next step, the up-to-date
// line says when it checked, and a failed check offers Try again and the releases page.
// INF-3405, the captain's words: "we still need to provide the "check for update" button because
// it could be that there's an even newer version". Direction B: Check for updates stays beside
// Update and restart, the version opens its release page, and a failed check keeps the update.
// Completion: the line's words and the update notice, with nothing downloaded.
test("Check for updates finds a release published within the same four hours, by keys", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 800 });
    await arrangeMacUpdates(launched, "0.1.30", { stable: "0.1.30" });
    // Command search opens Settings → General, focuses the button and presses it.
    await runFromSearch(app, page, "updates.check");
    const version = page.locator('[data-setting="version"]');
    const button = version.getByRole("button", { name: UPDATE_WORDS.check, exact: true });
    const line = version.locator("[data-update-line]");
    await expect(line).toHaveText(
      `${UPDATE_NOTICES.latest("stable")} ${UPDATE_STEP_WORDS.checked("now")}`,
    );
    await untilFocused(button);
    expect(await button.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    // Tab reaches it: away and back again, once the stops before it hold still. The local
    // model section right above the row, which every source checkout draws, draws only when
    // its own read answers, after the button already took focus; drawn between the two keys,
    // its switch took the Tab (INF-2840, alpha run 42224755343).
    await expect(page.locator("[data-local-seat]")).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(button).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    const checks = await app.evaluate(() => globalThis.__macUpdateFixture.checks);

    // A release published since: the saved answer still says up to date...
    await app.evaluate(() => {
      globalThis.__macUpdateFixture.targets.stable = "0.1.31";
    });
    expect(await page.evaluate(() => window.infinitary.update.status())).toMatchObject({
      updateAvailable: false,
    });
    // ...and a press reads the feed now.
    await pressKey(button, "Enter");
    await expect(line).toHaveText(new RegExp(UPDATE_NOTICES.available("0.1.31")));
    expect(await app.evaluate(() => globalThis.__macUpdateFixture.checks)).toBe(checks + 1);
    await expect(page.getByRole("button", { name: "Update available: 0.1.31" })).toBeVisible();
    // The row's next step is now Update and restart, as in the update notice, with Check for
    // updates still beside it; installing still waits for its own click.
    await expect(version.getByRole("button", { name: UPDATE_WORDS.restart })).toBeVisible();
    await expect(button).toBeFocused();
    await regionShot(version.locator(".."), test.info().outputPath("check-found-dark.png"));
    await pressKey(page.getByRole("button", { name: "Update available: 0.1.31" }), "Enter");
    const panel = page.locator("[data-update-channel]");
    await expect(panel.locator("[data-update-line]")).toHaveText(await line.innerText());
    await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toBeVisible();
    await expect(panel.getByRole("button", { name: UPDATE_WORDS.check })).toBeVisible();
    expect(await app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(0);
    await page.keyboard.press("Escape");

    // An even newer release: the row's Check for updates finds it, and nothing downloads.
    // The notice opened from the main window, so Settings opens again by its command.
    await app.evaluate(() => {
      globalThis.__macUpdateFixture.targets.stable = "0.1.32";
    });
    await runFromSearch(app, page, "settings.open");
    await expect(button).toBeVisible();
    await pressKey(button, "Enter");
    await expect(line).toHaveText(
      `${UPDATE_NOTICES.available("0.1.32")} ${UPDATE_STEP_WORDS.checked("now")} ${UPDATE_STEP_WORDS.restarts}`,
    );
    await expect(button).toBeFocused();
    await expect(page.getByRole("button", { name: "Update available: 0.1.32" })).toBeVisible();
    expect(await app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(0);

    // The version in the line opens the release page, as View release did.
    await pressKey(version.getByRole("button", { name: "0.1.32", exact: true }), "Enter");
    await expect
      .poll(() => app.evaluate(() => globalThis.__macUpdateFixture.opened.length))
      .toBe(1);

    // A check that cannot read the feed says so and keeps the update it found; it never says
    // the copy is up to date.
    await app.evaluate(() => {
      globalThis.__macUpdateFixture.failCheck = true;
    });
    await runFromSearch(app, page, "updates.check");
    await expect(line).toHaveText(
      `${UPDATE_PROBLEMS.checkFailed} ${UPDATE_NOTICES.stillAvailable("0.1.32")} ${UPDATE_STEP_WORDS.restarts}`,
    );
    await expect(version.getByRole("button", { name: UPDATE_WORDS.restart })).toBeVisible();
    await expect(page.getByRole("button", { name: "Update available: 0.1.32" })).toBeVisible();
    await untilFocused(button);
    await regionShot(version.locator(".."), test.info().outputPath("check-failed-dark.png"));
  } finally {
    await launched.close();
  }
});
