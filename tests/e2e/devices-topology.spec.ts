import { expect, test } from "@playwright/test";
import type { DeviceView } from "@shared/devices";
import { inLanguage } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import { openDevices } from "./deviceFixtures";
import { launchApp } from "./launch";
import { resizeWindow, within } from "./layout";
import { pressKey } from "./windowKeys";

// The documented keyboard route and the fix for a stale address question.
// Only device facts are seeded; the built app handles keyboard input and the refresh.
test("Devices selects by keyboard and does not reopen an invalidated address question", async () => {
  const local: DeviceView = {
    id: "local",
    kind: "mac",
    name: "Workshop",
    pairedAt: 1,
    heldOnLocalNetwork: true,
    inReach: false,
  };
  const viewer: DeviceView = {
    id: "viewer",
    kind: "view",
    name: "Travel laptop",
    pairedAt: 2,
    inReach: true,
  };
  const restored = { ...local, name: "Workshop desktop" };
  const app = await launchApp({ withMockProvider: true });
  try {
    await app.app.evaluate(
      ({ ipcMain }, peers) => {
        ipcMain.removeHandler("inf:devices:list");
        ipcMain.handle("inf:devices:list", () => peers);
      },
      [local, viewer],
    );
    const refresh = (peer: DeviceView) =>
      app.app.evaluate(
        ({ BrowserWindow }, peers) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send("inf:devices", peers);
          }
        },
        [peer, viewer],
      );
    const { page } = app;
    await openDevices(page);
    const topology = page.locator("[data-device-topology]");
    const stage = topology.locator('[data-layout="map"]');
    const home = stage.locator('[data-device-select="this-mac"]');
    const workshop = stage.locator('[data-device-select="local"]');
    const travel = stage.locator('[data-device-select="viewer"]');
    await expect(travel).toBeVisible();
    await pressKey(
      topology.getByRole("button", { name: m.settingsDevicesListMode(), exact: true }),
      "Tab",
    );
    await expect(home).toBeFocused();
    await pressKey(home, "ArrowLeft");
    await expect(travel).toBeFocused();
    await pressKey(travel, "ArrowLeft");
    await expect(workshop).toBeFocused();
    await expect(home).toHaveAttribute("aria-pressed", "true");
    await pressKey(workshop, "Enter");
    await expect(workshop).toHaveAttribute("aria-pressed", "true");

    const add = page.locator("[data-device-inspector]").getByRole("button", {
      name: m.settingsDevicesAddByAddressNamed({ device: local.name }),
    });
    await add.click();
    const form = page.locator('[data-device-address-change="local"]');
    await expect(form).toBeVisible();
    await refresh({ ...local, heldOnLocalNetwork: false });
    await expect(form).toHaveCount(0);
    await pressKey(travel, "Enter");
    await expect(travel).toHaveAttribute("aria-pressed", "true");
    await refresh(restored);
    await expect(workshop).toHaveAttribute("title", restored.name);
    await expect(travel).toHaveAttribute("aria-pressed", "true");
    await expect(form).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// The localized retry explanation and setup can occupy the same seat.
test("Devices keeps localized retry and progress clear of the map controls", async () => {
  const retry: DeviceView = {
    id: "retry",
    kind: "mac",
    name: "Werkstatt",
    pairedAt: 10,
    seenAt: 11,
    inReach: false,
    ssh: { state: "reconnecting" },
    workSetup: { state: "starting" },
  };
  // Eight ordinary tiles fit first. On the second page the taller retry tile
  // occupies the center column, where it cannot clear both Home and the header.
  const peers: DeviceView[] = [
    ...Array.from(
      { length: 9 },
      (_, i): DeviceView => ({
        id: `peer-${i}`,
        kind: "view",
        name: `Computer ${i + 1}`,
        pairedAt: i + 1,
        inReach: true,
      }),
    ),
    retry,
  ];
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    await app.app.evaluate(({ ipcMain }, devices) => {
      ipcMain.removeHandler("inf:devices:list");
      ipcMain.handle("inf:devices:list", () => devices);
    }, peers);
    await resizeWindow(app.app, page, { width: 1320, height: 1010 });
    await openDevices(page);
    await page.evaluate(async () => {
      const appearance = await window.infinitary.settings.getAppearance();
      await window.infinitary.settings.setAppearance({ ...appearance, language: "de" });
    });
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await page.locator('[data-settings-tab="devices"]').click();
    const topology = page.locator("[data-device-topology]");
    const stage = topology.locator("[data-layout]");
    const tile = stage.locator('[data-device-select="retry"]');
    const first = stage.locator('[data-device-select="peer-0"]');
    const map = topology.getByRole("button", { name: inLanguage("de", m.settingsDevicesMapMode) });
    const list = topology.getByRole("button", {
      name: inLanguage("de", m.settingsDevicesListMode),
    });
    const next = topology.getByRole("button", { name: inLanguage("de", m.settingsDevicesMapNext) });
    await expect(stage).toHaveAttribute("data-layout", "map");
    await expect(tile).toHaveCount(0);
    await pressKey(first, "Enter");
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await pressKey(next, "Enter");
    await expect(stage).toHaveAttribute("data-layout", "list");
    await expect(list).toBeFocused();
    await expect(map).toBeVisible();
    await expect(map).toBeDisabled();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(tile).toContainText(inLanguage("de", m.settingsDevicesMapReconnectingSsh));
    await expect(tile).toContainText(inLanguage("de", m.settingsDevicesMapWaitingForWork));
    await expect(tile).toContainText(inLanguage("de", m.settingsDevicesSettingUp));
    await pressKey(tile, "Enter");
    await expect(tile).toBeFocused();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => {
        const bounds = await stage.boundingBox();
        const ring = await tile.evaluate((button) => {
          const b = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          const pad =
            Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
          return {
            x: b.x - pad,
            y: b.y - pad,
            width: b.width + 2 * pad,
            height: b.height + 2 * pad,
          };
        });
        return bounds ? within(ring, bounds) : ["stage missing"];
      })
      .toEqual([]);
  } finally {
    await app.close();
  }
});
