import type { DeviceAddresses } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  afterNextFrame,
  button,
  gone,
  held,
  openDevices,
  shown,
  unansweredOf,
} from "./devicesTab";
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
  // The home's answer is slow, as a Windows PC's firewall look makes it.
  const read = held<DeviceAddresses>();
  bridge.answer("inf:devices:addresses", () => read.promise);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", { state: "off", user: null, macs: [] });
  await openSize();
  await openWindow(bridge);
  const devices = await openDevices();
  await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
  const aside = await shown("[data-device-address-question]");
  // Before the home answers, no address form and no look for computers nearby.
  expect(document.querySelector("#device-remote-login")).toBeNull();
  expect(bridge.requests("inf:devices:nearby").filter(([watching]) => watching)).toEqual([]);
  read.resolve({ ...ADDRESSES, addsByAddress: false });
  await afterNextFrame();
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
  // A Windows home never looks for computers nearby.
  expect(bridge.requests("inf:devices:nearby").filter(([watching]) => watching)).toEqual([]);
  expect(unansweredOf(bridge)).toEqual([]);
});
