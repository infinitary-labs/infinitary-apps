import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { ADDRESSES, button, gone, openDevices, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Adding a computer from a Windows PC's first mate in Settings -> Devices
 * (docs/devices.md, "Adding a computer by its address"; docs/view.md).
 */

// The review of INF-4926's plan: a Windows PC's first mate adds no computer by its address (its own
// ssh keeps no control connection), so + A computer there offers the link and the command alone.
test("a Windows PC's first mate offers the link and the command in place of the address form", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:list", []);
  bridge.answer("inf:devices:addresses", { ...ADDRESSES, addsByAddress: false });
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", { state: "off", user: null, macs: [] });
  await openSize();
  await openWindow(bridge);
  const devices = await openDevices();
  await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
  const aside = await shown("[data-device-address-question]");
  expect(document.querySelector("#device-remote-login")).toBeNull();
  const ways = aside.querySelector("[data-device-other-ways]") as HTMLElement;
  expect(ways.textContent).toContain(m.settingsDevicesAddWays());
  // The link comes first and takes the focus; Cancel closes the aside.
  const link = button(ways, m.settingsDevicesAddByLink());
  await expect.poll(() => document.activeElement).toBe(link);
  expect(button(ways, m.settingsDevicesAddByCommand()).parentElement?.textContent).toContain(
    m.settingsDevicesAddByCommandWhen(),
  );
  await userEvent.click(button(aside, m.settingsDevicesCancel()));
  await gone("[data-device-address-question]");
  expect(unansweredOf(bridge)).toEqual([]);
});
