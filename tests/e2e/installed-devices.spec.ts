import { expect, test } from "@playwright/test";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { commandSearch, pressWindowKey } from "./windowKeys";

/**
 * Multi-machine support in an installed build (docs/devices.md): the same
 * Devices, + A phone included, first-launch joining and device cards a
 * development run offers, through the real core, shell, preload and renderer
 * with the installed flag. No link is made here: an installed build listens
 * on this Mac's own network, which a test never does (devices.spec.ts and
 * view.spec.ts make and use links on loopback).
 */

test("an installed build offers joining at its first launch, Settings -> Devices and its command", async () => {
  const app = await launchApp({ packaged: true });
  try {
    const { page } = app;
    await expect(page.locator('[data-first-run-gate="open"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste its link", exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    await expect(page.locator('[data-device-add="mac"]')).toBeVisible();
    // Command search lists Devices' own command.
    await pressWindowKey(app.app, "k", ["meta"]);
    const search = commandSearch(page);
    await expect(search.dialog).toBeVisible();
    await expect(search.row("devices.try-again")).toHaveCount(1);
    await page.keyboard.press("Escape");
    // The listed command means the build's answer has arrived, with + A phone
    // offered now the phone app is on TestFlight (the captain's "Show it now,
    // as you chose for TestFlight", INF-279).
    await expect(page.locator('[data-device-add="user"]')).toBeVisible();
    await expect(page.locator('[data-device-add="phone"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test("asking an installed Firstmate to connect a Mac offers its card", async () => {
  const app = await launchApp({ packaged: true, withMockProvider: true });
  try {
    const { page } = app;
    const input = promptInput(page);
    await input.fill(
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "device-invite", value: { name: "MacBook Air" } }),
    );
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "Make a link", exact: true })).toBeVisible();
    await waitForFirstmateIdle(page);
  } finally {
    await app.close();
  }
});
