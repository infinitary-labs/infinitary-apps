import type { Card } from "@shared/cards";
import type { DeviceView } from "@shared/devices";
import {
  DEVICE_UPDATE_ACTIONS,
  type DeviceUpdateNudgeFacts,
  deviceUpdateCardId,
  deviceUpdateTitle,
} from "@shared/deviceUpdateNudge";
import { remoteLoginWords } from "@shared/remoteLogin";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { ADDRESSES, AIR, held, MINI, STUDIO, shown, unansweredOf } from "./devicesTab";
import { seededHome, subscribed } from "./freshHome";
import { answerStack } from "./stack";
import { openSize, openWindow } from "./window";

const row = (id: string) => document.querySelector<HTMLElement>(`[data-device-row="${id}"]`);

function factsOf(device: DeviceView): DeviceUpdateNudgeFacts {
  if (!device.otherVersion) throw new Error(`${device.name} is on this computer's version`);
  return {
    deviceId: device.id,
    name: device.name,
    user: device.user,
    onThisMac: device.onThisMac,
    remoteLogin: device.remoteLogin,
    other: device.otherVersion,
  };
}

// INF-2115 (docs/devices.md, "Updating by itself"): when this Mac cannot
// update a computer alone, its update card's Update it is the captain's
// way to do it. The press opens Settings -> Devices on that computer and
// asks its update there, as the row's own Update does, and the row reads
// as updating until the update answers.
test("the update card's Update it opens Devices and updates that computer there", async () => {
  const facts = factsOf(MINI);
  const home = subscribed(await seededHome(facts));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  const listed = home["inf:cards:list"] as Card[];
  const card = listed.find((each) => each.id === deviceUpdateCardId(MINI.id));
  const updateIt = card?.actions?.find((action) =>
    action.id.startsWith(`${DEVICE_UPDATE_ACTIONS.update}@`),
  );
  const opens = updateIt?.effect;
  if (!updateIt || opens?.kind !== "open")
    throw new Error("The seeded update card offers no Update it that opens Devices");
  // The core answers an open effect's press with the effect the window carries out.
  bridge.answer("inf:cards:act", { effect: opens });
  bridge.answer("inf:devices:list", () => [AIR, MINI, STUDIO]);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", (watching) => ({
    state: watching ? "looking" : "off",
    user: null,
    macs: [],
  }));
  const updated = held<DeviceView>();
  bridge.answer("inf:devices:update", () => updated.promise);
  await openSize();
  await openWindow(bridge);

  const title = deviceUpdateTitle(facts);
  await userEvent.click(
    page
      .getByRole("region", { name: title, exact: true })
      .getByRole("button", { name: updateIt.label, exact: true }),
  );
  await expect.poll(() => bridge.requests("inf:devices:update")).toEqual([[MINI.id, {}]]);
  await shown('[data-device-row="mini"]');
  await expect.poll(() => row("mini")?.textContent).toContain(remoteLoginWords.updatingRow(MINI));

  updated.resolve(MINI);
  await expect
    .poll(() => row("mini")?.textContent)
    .not.toContain(remoteLoginWords.updatingRow(MINI));
  expect(bridge.requests("inf:cards:act").map(([cardId, actionId]) => [cardId, actionId])).toEqual([
    [deviceUpdateCardId(MINI.id), updateIt.id],
  ]);
  expect(unansweredOf(bridge)).toEqual([]);
});
