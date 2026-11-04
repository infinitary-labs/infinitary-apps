import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Phase 7 (docs/architecture.md §17): the update indicator with the cask
 * upgrade command. A run from source offers an update so the indicator can
 * be seen; with no installer marker in the home's own data root and a
 * stable version, the subscription is stable (docs/alpha.md "Update
 * channels"). The fresh home's core answers that offer, its upgrade
 * command written by the channel module's `upgradeCommandFor`
 * (src/core/update/updateChannels.ts), which a page cannot load.
 */

test("the update indicator opens with the cask upgrade command", async () => {
  const bridge = fakeBridge(freshHome());
  await openSize();
  await openWindow(bridge);
  const indicator = page.getByRole("button", { name: /Update available/ });
  await expect.element(indicator).toBeVisible();
  await userEvent.click(indicator);
  const { latestVersion, channel, upgradeCommand } = await bridge.api.update.status();
  expect(latestVersion).toBeTruthy();
  expect(channel).toBe("stable");
  expect(upgradeCommand).toBeTruthy();
  const offered = () => document.querySelector("[data-update-offered]");
  await expect.poll(() => offered()?.textContent).toContain(latestVersion as string);
  expect(document.querySelector("[data-update-channel]")?.getAttribute("data-update-channel")).toBe(
    "stable",
  );
  await expect.element(page.getByText(upgradeCommand, { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "View release" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(offered).toBeNull();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
