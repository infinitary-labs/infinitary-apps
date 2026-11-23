import * as m from "@shared/i18n/messages.generated";
import type { SetUpHere } from "@shared/joinByAddress";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { chooseAtWelcome, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * A Windows PC's first launch keeps its two chips (INF-4931's plan, round 3): only a Mac or an
 * x64 Linux computer can be added by its address, so it offers no Set up from your first mate's
 * computer. The Mac's view is join-set-up.test.tsx.
 */

test("a Windows PC keeps the two chips, with no set up from the first mate's computer", async () => {
  const home = freshHome();
  // What a Windows PC reads of itself: the address way sets nothing up there.
  const windows: SetUpHere = {
    offered: false,
    user: null,
    privateAddress: null,
    localName: null,
    remoteLogin: "unknown",
    line: null,
    lineAt: null,
    opensSharing: false,
  };
  const bridge = fakeBridge({ ...home, "inf:devices:set-up-here": windows });
  await openSize();
  await openWindow(bridge);
  await chooseAtWelcome("running");
  const group = await shown('[data-join-another-mac="closed"]');
  await expect.poll(() => bridge.requests("inf:devices:set-up-here").length).toBeGreaterThan(0);
  const chips = [...group.querySelectorAll<HTMLButtonElement>(".fm-connect-chip")];
  expect(chips.map((chip) => chip.textContent)).toEqual([
    m.devicesJoinPasteChip(),
    m.devicesJoinAddressChip(),
  ]);
  expect(group.querySelector("[data-join-set-up-chip]")).toBeNull();
  expect(unansweredOf(bridge)).toEqual([]);
});
