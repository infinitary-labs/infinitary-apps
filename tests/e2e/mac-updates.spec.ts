import { expect, test } from "@playwright/test";
import { homebrewInstallationReceipt } from "../../src/core/update/macInstallation";
import { INFINITARY_TAP, upgradeCommandFor } from "../../src/core/update/updateChannels";
import { UPDATE_PROBLEMS, UPDATE_WORDS } from "../../src/shared/updateWords";
import { startDemo } from "./demo";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { arrangeMacUpdates } from "./macUpdateFixture";
import { heroShot, regionShot } from "./pictures";
import { setThemeViaSettings } from "./theme";
import { pressKey, runFromSearch } from "./windowKeys";

// INF-640: keyboard channel selection, persisted membership and consent/progress/error UI.
// Fixture: real source app/controller, isolated HOME/userData and native effects stood in.
// Completion: persisted channel after restart, cancellation before replacement, and visible failure recovery.
// No signing, installed-app replacement, shared account, native focus or real download is exercised here.
test("a saved channel survives restart and stable never downgrades an ahead alpha", async () => {
  let launched = await launchApp({ withMockProvider: true });
  const root = launched.userDataDir;
  try {
    await arrangeMacUpdates(launched, "0.5.1-alpha.9");
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    const choice = page.getByRole("radiogroup", { name: UPDATE_WORDS.channel });
    await pressKey(choice.getByRole("radio", { name: "Alpha", exact: true }), "ArrowLeft");
    await expect(choice.getByRole("radio", { name: "Stable", exact: true })).toBeChecked();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.update.status()))
      .toMatchObject({ channel: "stable", updateAvailable: false, latestVersion: "0.5.0" });
    for (const theme of ["dark", "light"] as const) {
      await setThemeViaSettings(page, theme, { close: false });
      await regionShot(
        page.locator('[data-setting="update-channel"]'),
        test.info().outputPath(`channel-${theme}.png`),
      );
    }
    await launched.close();
    launched = await launchApp({ withMockProvider: true, userDataDir: root });
    await arrangeMacUpdates(launched, "0.5.1-alpha.9");
    expect(await launched.page.evaluate(() => window.infinitary.update.status())).toMatchObject({
      channel: "stable",
      updateAvailable: false,
    });
    expect(await launched.app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
  } finally {
    await launched.close();
  }
});

test("update consent exposes progress and a recoverable installation error", async () => {
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
        await regionShot(panel, test.info().outputPath("update-error-dark.png"));
        await demo.step(async () => {
          await pressKey(panel.getByRole("button", { name: UPDATE_WORDS.release }), "Enter");
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
    await arrangeMacUpdates(launched, "0.5.0-alpha.9");
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
      .toMatchObject({ channel: "stable", latestVersion: "0.5.0", phase: "idle" });
    expect(await app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
    await page.keyboard.press("Escape");
    await pressKey(page.getByRole("button", { name: /Update available/ }), "Enter");
    await expect(page.locator("[data-update-channel]")).toHaveAttribute(
      "data-update-channel",
      "stable",
    );
    await expect(page.locator("[data-update-problem]")).toHaveCount(0);
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
      await expect(panel.getByRole("button", { name: UPDATE_WORDS.release })).toBeFocused();
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

// Captain's revised INF-643: Homebrew remains supported and must never use native replacement.
// The real controller/IPC/rendered notice choose from a cask-produced receipt; effects are stood in.
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
      await expect(
        panel.getByText(upgradeCommandFor("stable", INFINITARY_TAP), { exact: true }),
      ).toBeVisible();
      await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toHaveCount(0);
      expect((await page.evaluate(() => window.infinitary.update.install())).ok).toBe(false);
      expect(await app.evaluate(() => globalThis.__macUpdateFixture.downloads)).toBe(0);
      expect(await app.evaluate(() => globalThis.__macUpdateFixture.installations)).toBe(0);
      await regionShot(panel, test.info().outputPath(`homebrew-update-${theme}.png`));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "General", exact: true }).click();
      await expect(page.getByRole("radiogroup", { name: UPDATE_WORDS.channel })).toHaveCount(0);
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
