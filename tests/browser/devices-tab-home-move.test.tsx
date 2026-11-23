import { type DeviceView, deviceLabel } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  AIR,
  button,
  gone,
  LISTED_AT,
  openDevices,
  selectDevice,
  shown,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Start my first mate here again, under a computer's row in Settings ->
 * Devices (docs/devices.md, "A destination that never answers"; design skill
 * components/devices/DevicesTab, "Moving your first mate"): offered only by
 * a step that says so, it starts nothing until the captain confirms under a
 * warning, and Keep waiting holds the focus there, so Enter never starts a
 * second first mate.
 */

/** A computer that runs work, another user's on this Mac, the move's destination. */
const MINI: DeviceView = {
  id: "mini",
  kind: "work",
  name: "Mac mini",
  pairedAt: LISTED_AT - 7_200_000,
  inReach: false,
  seenAt: LISTED_AT - 600_000,
  tasks: 0,
  runs: [],
};

test("Start my first mate here again asks first under a warning, and Enter there keeps waiting", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:list", [AIR, MINI]);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", { state: "off", user: null, macs: [] });
  bridge.answer("inf:home-move:start-here", {
    ok: true,
    text: "Your first mate starts here again.",
  });
  await openSize();
  await openWindow(bridge);
  await openDevices();
  await selectDevice("mini");
  await shown('[data-device-row="mini"]');
  const label = deviceLabel(MINI);
  const waiting = {
    deviceId: "mini",
    name: label,
    stage: "arriving",
    text: `Waiting for ${label} to answer.`,
  } as const;

  // Section: while the destination may still answer, the move offers nothing.
  bridge.push("inf:home-move:progress", waiting);
  const aside = await shown('[data-home-move="mini"]');
  expect(aside.textContent).toContain(waiting.text);
  expect(aside.textContent).not.toContain(m.settingsDevicesMoveStartHere());

  // Section: the offer opens a warning, with Keep waiting focused; Enter keeps waiting.
  bridge.push("inf:home-move:progress", { ...waiting, startHere: true });
  await expect.poll(() => aside.textContent).toContain(m.settingsDevicesMoveStartHere());
  await userEvent.click(button(aside, m.settingsDevicesMoveStartHere()));
  const sure = await shown("[data-home-move-sure]");
  expect(sure.textContent).toBe(m.settingsDevicesMoveStartHereSure({ device: label }));
  await expect
    .poll(() => (document.activeElement as HTMLElement | null)?.innerText.trim())
    .toBe(m.settingsDevicesMoveKeepWaiting());
  await userEvent.keyboard("{Enter}");
  await gone("[data-home-move-sure]");
  expect(bridge.requests("inf:home-move:start-here")).toEqual([]);

  // Section: the destination back in reach takes the offer away.
  bridge.push("inf:home-move:progress", waiting);
  await expect.poll(() => aside.textContent).not.toContain(m.settingsDevicesMoveStartHere());

  // Section: offered again, Start it here is the one click that starts it.
  bridge.push("inf:home-move:progress", { ...waiting, startHere: true });
  await expect.poll(() => aside.textContent).toContain(m.settingsDevicesMoveStartHere());
  await userEvent.click(button(aside, m.settingsDevicesMoveStartHere()));
  await shown("[data-home-move-sure]");
  await userEvent.click(button(aside, m.settingsDevicesMoveStartHereConfirm()));
  await expect.poll(() => bridge.requests("inf:home-move:start-here")).toEqual([[]]);
});
