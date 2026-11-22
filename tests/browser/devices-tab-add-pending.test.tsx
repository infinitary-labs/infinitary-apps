import type { DeviceAddresses } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { ADDRESSES, button, gone, held, openDevices, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * + A computer while the home has not yet said whether it adds a computer by its address
 * (docs/devices.md, "Adding a computer by its address"); a Windows home's answer is
 * devices-tab-add-windows.test.tsx.
 */

// The review of INF-5409: while the home has not said whether it adds by its address, + A computer
// shows the two other ways alone, with the link focused; the answer that it does puts the form in
// their place, with the caret in its field and the two ways under it.
test("a slow answer shows the other ways alone, then the address form in their place", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:list", []);
  const read = held<DeviceAddresses>();
  bridge.answer("inf:devices:addresses", () => read.promise);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", { state: "off", user: null, macs: [] });
  await openSize();
  await openWindow(bridge);
  const devices = await openDevices();
  await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
  const aside = await shown("[data-device-address-question]");
  const pending = aside.querySelector("[data-device-other-ways]") as HTMLElement;
  expect(pending.textContent).toContain(m.settingsDevicesAddWays());
  await expect
    .poll(() => document.activeElement)
    .toBe(button(pending, m.settingsDevicesAddByLink()));
  expect(document.querySelector("#device-remote-login")).toBeNull();
  expect(bridge.requests("inf:devices:nearby").filter(([watching]) => watching)).toEqual([]);
  read.resolve(ADDRESSES);
  const field = await shown("#device-remote-login");
  await expect.poll(() => document.activeElement).toBe(field);
  const form = await shown("[data-device-address-question]");
  const ways = form.querySelector("[data-device-other-ways]") as HTMLElement;
  expect(ways.textContent).toContain(m.settingsDevicesAddOtherWays());
  await expect.poll(() => bridge.requests("inf:devices:nearby")).toContainEqual([true]);
  await userEvent.click(button(form, m.settingsDevicesCancel()));
  await gone("[data-device-address-question]");
  expect(unansweredOf(bridge)).toEqual([]);
});
