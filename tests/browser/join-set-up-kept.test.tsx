import type { FirstRunView } from "@shared/firstRun";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The review of INF-4930: a first launch where something was already set up - a saved sign-in
 * needing a fresh check, say - still offers Set up from your first mate's computer, but never
 * promises the window opens that first mate by itself, and never asks the shell to follow along,
 * which it would refuse. The untouched profile's view is join-set-up.test.tsx.
 */

test("a first launch with something set up promises no switch and asks for none", async () => {
  const home = freshHome();
  const { untouched: _untouched, ...used } = home["inf:app:first-run"] as FirstRunView;
  expect(used.gateOpen).toBe(true);
  const bridge = fakeBridge({ ...home, "inf:app:first-run": used });
  await openSize();
  await openWindow(bridge);
  await userEvent.click(await shown("[data-join-set-up-chip]"));
  const aside = await shown("[data-join-set-up]");
  const status = aside.querySelector(".fm-join-waiting[role=status]");
  expect(status?.textContent).toBe(m.devicesJoinSetUpKept());
  expect(aside.textContent).not.toContain(m.devicesJoinSetUpWaiting());
  // The address to type there is still shown, with Copy.
  expect(aside.querySelectorAll("[data-join-set-up-address]").length).toBeGreaterThan(0);
  expect(bridge.requests("inf:devices:follow-added")).toEqual([]);
  expect(unansweredOf(bridge)).toEqual([]);
});
