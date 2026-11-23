import type { FirstRunView } from "@shared/firstRun";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { chooseAtWelcome, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The review of INF-4930: a first launch where something was already set up - a saved sign-in
 * needing a fresh check, say - still offers Set up from your first mate's computer, but never
 * promises the window opens that first mate by itself. It still asks the shell, which then keeps
 * this window's own first mate after a restart too. The untouched profile's view is
 * join-set-up.test.tsx, and beside a first mate started outside the window
 * join-set-up-stays.test.tsx.
 */

test("a first launch with something set up promises no switch", async () => {
  const home = freshHome();
  const { untouched: _untouched, ...used } = home["inf:app:first-run"] as FirstRunView;
  expect(used.gateOpen).toBe(true);
  // The shell answers as it does for a used profile: it would not follow along, though both other ways join.
  const bridge = fakeBridge({
    ...home,
    "inf:app:first-run": used,
    "inf:devices:follow-added": {
      followed: false,
      follows: false,
      joins: true,
      pastes: true,
      outside: false,
    },
  });
  await openSize();
  await openWindow(bridge);
  await chooseAtWelcome("running");
  await userEvent.click(await shown("[data-join-set-up-chip]"));
  const aside = await shown("[data-join-set-up]");
  const status = aside.querySelector(".fm-join-waiting[role=status]");
  expect(status?.textContent).toBe(m.devicesJoinSetUpKept());
  expect(aside.textContent).not.toContain(m.devicesJoinSetUpWaiting());
  // The address to type there is still shown, with Copy.
  expect(aside.querySelectorAll("[data-join-set-up-address]").length).toBeGreaterThan(0);
  // The shell is asked, so it notes this window keeps its own first mate when a grant comes.
  expect(bridge.requests("inf:devices:follow-added").length).toBeGreaterThan(0);
  expect(unansweredOf(bridge)).toEqual([]);
});
