import type { AccountView } from "@shared/accounts";
import { hereAs } from "@shared/deviceNames";
import type { ThisMac } from "@shared/devices";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { DeviceSignIns } from "@shared/signIns";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SUBSCRIPTIONS_WORDS } from "../../src/renderer/src/settings/subscriptionsWords";
import { fakeBridge } from "./bridge";
import { shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Settings -> Intelligence on a computer that controls the first mate
 * (docs/view.md, "Settings on a view"; design skill
 * components/devices/SignInOnAMac): each account row's words say "this
 * computer" of the computer the account is on. The first mate's own rows
 * name the first mate's computer, and a work computer's rows, under its own
 * group, name that work computer. The bug it guards (INF-3492, from
 * INF-1357's review): a work computer's Claude row that was not signed in
 * told the person to sign in on the first mate's computer.
 */

/** The computer the first mate lives on, as this view names it. */
const FIRST_MATE_COMPUTER = "Mac mini";
/** A computer that runs the first mate's work, under its own group. */
const WORK_COMPUTER = "iMac";

/** This window controls the first mate on Mac mini, in reach. */
const VIEW: ThisMac = {
  role: "view",
  name: FIRST_MATE_COMPUTER,
  address: "192.168.1.20",
  joinedAt: Date.now() - 3_600_000,
  contact: "in-reach",
  readOnly: null,
  heardAt: Date.now(),
  caughtUp: 0,
};

function claudeNotSignedIn(id: string): AccountView {
  return {
    id,
    providerId: CLAUDE_PROVIDER_ID,
    kind: "subscription_oauth",
    label: "Claude",
    enabled: true,
    connected: false,
    pinned: false,
    createdAt: Date.now() - 86_400_000,
  };
}

const OWN = claudeNotSignedIn("acct_claude_home");
const THERE = claudeNotSignedIn("acct_claude_imac");

const IMAC: DeviceSignIns = {
  deviceId: "imac",
  name: WORK_COMPUTER,
  onThisMac: false,
  reach: "in-reach",
  customApi: true,
  flows: [],
  signIns: { providers: [], accounts: [THERE], quota: null },
};

test("on a view, a work computer's own account row names that computer and the first mate's names the first mate's", async () => {
  const bridge = fakeBridge(freshHome());
  bridge.answer("inf:devices:this-mac", VIEW);
  bridge.answer("inf:accounts:list", [OWN]);
  bridge.answer("inf:devices:shown", { shown: true });
  bridge.answer("inf:devices:sign-ins", [IMAC]);
  await openSize();
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Intelligence", exact: true }));

  const own = await shown(`[data-account-row="${OWN.id}"]`);
  const there = await shown(
    `[data-device-sign-ins="${IMAC.deviceId}"] [data-account-row="${THERE.id}"]`,
  );
  expect(own.textContent).toContain(
    hereAs(SUBSCRIPTIONS_WORDS.claudeFirstRun, FIRST_MATE_COMPUTER),
  );
  expect(there.textContent).toContain(hereAs(SUBSCRIPTIONS_WORDS.claudeFirstRun, WORK_COMPUTER));
  expect(there.textContent).not.toContain(FIRST_MATE_COMPUTER);
  expect(unansweredOf(bridge)).toEqual([]);
});
