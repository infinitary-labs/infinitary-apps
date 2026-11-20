import { type DeviceView, deviceLabel } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  AIR,
  button,
  LISTED_AT,
  MINI as OLDER_MINI,
  openDevices,
  STUDIO,
  selectDevice,
  shown,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Move your first mate here, on a computer's row in Settings -> Devices
 * (docs/devices.md, "Moving the first mate"; design skill
 * components/devices/DevicesTab, "Moving your first mate"): only a computer
 * in reach on this computer's version offers it, and its Ready list keeps
 * Move now off while a gap there blocks the move.
 */

/** A computer that runs work, in reach on this computer's version: the one row that offers the move. */
const BOX: DeviceView = {
  id: "box",
  kind: "work",
  name: "Build box",
  pairedAt: LISTED_AT - 7_200_000,
  inReach: true,
  seenAt: LISTED_AT,
  connectedAt: LISTED_AT - 600_000,
  tasks: 0,
  runs: [],
};

test("only a computer in reach on this version offers the move, and Move now stays off while a gap blocks it", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  // An older computer in reach, one out of reach, and one in reach on this version.
  bridge.answer("inf:devices:list", [AIR, OLDER_MINI, STUDIO, BOX]);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", { state: "off", user: null, macs: [] });
  const label = deviceLabel(BOX);
  // The core's own Ready list, as its answer carries it: one gap that blocks and one note.
  const blocking = `${label} runs a first mate of its own now.`;
  const noting = `You sign in to Claude again on ${label}.`;
  bridge.answer("inf:home-move:ready", {
    deviceId: "box",
    name: label,
    gaps: [
      { id: "first-mate-there", level: "blocks", text: blocking },
      { id: "sign-ins", level: "notes", text: noting },
    ],
  });
  await openSize();
  await openWindow(bridge);
  await openDevices();

  // Section: the older computer and the one out of reach offer nothing; the one in reach on this version does.
  await selectDevice("mini");
  await shown('[data-device-row="mini"]');
  expect(document.querySelector('[data-home-move-ask="mini"]')).toBeNull();
  await selectDevice("studio");
  await shown('[data-device-row="studio"]');
  expect(document.querySelector('[data-home-move-ask="studio"]')).toBeNull();
  await selectDevice("box");
  await shown('[data-device-row="box"]');
  const ask = await shown('[data-home-move-ask="box"]');
  expect(ask.getAttribute("aria-label")).toBe(m.settingsDevicesMoveHereNamed({ device: label }));

  // Section: the Ready list names each gap, and the blocking one keeps Move now off.
  await userEvent.click(ask);
  const aside = await shown('[data-home-move="box"]');
  const block = await shown('[data-gap="first-mate-there"]');
  expect(block.getAttribute("data-level")).toBe("blocks");
  expect(block.textContent).toBe(blocking);
  expect(aside.querySelector('[data-gap="sign-ins"]')?.textContent).toBe(noting);
  const moveNow = button(aside, m.settingsDevicesMoveNow());
  expect(moveNow.disabled).toBe(true);
  expect(bridge.requests("inf:home-move:start")).toEqual([]);
});
