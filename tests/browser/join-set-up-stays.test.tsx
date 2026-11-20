import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The review of INF-5409: a window beside a first mate started outside it, which it may neither
 * stop nor leave, promises neither that it opens the first mate's computer by itself nor Paste its
 * link or Join by its address, though nothing was done here: the shell's answer says so. The
 * untouched profile's view is join-set-up.test.tsx.
 */

test("beside a first mate started outside the window, an untouched first launch promises no switch or join", async () => {
  const home = freshHome();
  // The shell runs beside a command this window did not start: it neither follows nor joins.
  const bridge = fakeBridge({
    ...home,
    "inf:devices:follow-added": { followed: false, follows: false, joins: false },
  });
  await openSize();
  await openWindow(bridge);
  await userEvent.click(await shown("[data-join-set-up-chip]"));
  const aside = await shown("[data-join-set-up]");
  await expect
    .poll(() => aside.querySelector(".fm-join-waiting[role=status]")?.textContent)
    .toBe(m.devicesJoinSetUpStays());
  expect(aside.textContent).not.toContain(m.devicesJoinSetUpWaiting());
  expect(aside.textContent).not.toContain(m.devicesJoinSetUpKept());
  expect(unansweredOf(bridge)).toEqual([]);
});
