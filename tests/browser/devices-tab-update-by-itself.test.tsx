import { deviceLabel } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { remoteLoginWords } from "@shared/remoteLogin";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  AIR,
  afterNextFrame,
  MINI,
  openDevices,
  STUDIO,
  selectDevice,
  shown,
  unansweredOf,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

const row = (id: string) => document.querySelector<HTMLElement>(`[data-device-row="${id}"]`);

// INF-2115, the captain's "The work computer installs the update the home
// installed on its own, with no card to click" (docs/devices.md, "Updating
// by itself"): an update this Mac started by itself reads in its row as a
// click's does, from its first count until it is done, and offers no Match
// meanwhile; a step with no count, as one that only asks a password, leaves
// the row as it was.
test("a computer this Mac updates by itself reads as updating in its row until it is done", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:list", () => [AIR, MINI, STUDIO]);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", (watching) => ({
    state: watching ? "looking" : "off",
    user: null,
    macs: [],
  }));
  await openSize();
  await openWindow(bridge);
  await openDevices();
  const mini = deviceLabel(MINI);
  await selectDevice("mini");
  const update = `[data-device-row="mini"] [aria-label="${m.settingsDevicesMatchNamed({ device: mini })}"]`;
  await shown(update);
  const said = (
    stage: "updating" | "done",
    text: string,
    copy?: { state: "sending"; sent: number },
  ) =>
    bridge.push("inf:event", {
      type: "device_setup",
      address: "sam@mini.local",
      doing: "update",
      stage,
      name: MINI.name,
      deviceId: "mini",
      text,
      tone: "info",
      ...(copy ? { copy } : {}),
    });

  said("updating", remoteLoginWords.updating(MINI));
  await afterNextFrame();
  expect(document.querySelector(update)).not.toBeNull();

  const sent = 96 * 1024 * 1024;
  said("updating", remoteLoginWords.sendingRow(mini, sent), { state: "sending", sent });
  await expect
    .poll(() => row("mini")?.textContent)
    .toContain(remoteLoginWords.sendingRow(mini, sent));
  expect(document.querySelector(update)).toBeNull();

  // Done, and the list still says it is older: the row reads as before, Match included.
  said("done", remoteLoginWords.updated(MINI, "running"));
  await shown(update);
  expect(row("mini")?.textContent).not.toContain(remoteLoginWords.sendingRow(mini, sent));
  expect(unansweredOf(bridge)).toEqual([]);
});
