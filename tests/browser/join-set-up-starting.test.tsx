import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The review of INF-5409: a command this window started that has not welcomed it yet, as on
 * Windows, where Task Scheduler accepts the start before the run begins, offers neither join, and
 * the window says nothing of a first mate started outside it, since none is: the shell's answer
 * leaves `outside` false. The window beside one started outside is join-set-up-stays.test.tsx's.
 */

test("while a command the window started is still starting, nothing says a first mate started outside it runs here", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  // The shell's answer while the command this window started has not welcomed it yet.
  bridge.answer("inf:devices:follow-added", {
    followed: false,
    follows: false,
    joins: false,
    pastes: false,
    outside: false,
  });
  await openSize();
  await openWindow(bridge);
  await shown("[data-join-set-up-chip]");
  await expect.poll(() => bridge.requests("inf:devices:follow-added").length).toBeGreaterThan(0);
  const paste = await shown("[data-join-chip]");
  const byAddress = await shown("[data-join-address-chip]");
  // Neither join is offered, and no line names a first mate started outside this window.
  expect([
    (paste as HTMLButtonElement).disabled,
    (byAddress as HTMLButtonElement).disabled,
  ]).toEqual([true, true]);
  expect(document.querySelector("[data-join-stays]")).toBeNull();
  // The open aside promises nothing either.
  await userEvent.click(await shown("[data-join-set-up-chip]"));
  const aside = await shown("[data-join-set-up]");
  await shown("[data-join-set-up-address]");
  expect(aside.querySelector(".fm-join-waiting[role=status]")?.textContent).toBe("");
  for (const promise of [
    m.devicesJoinSetUpWaiting(),
    m.devicesJoinSetUpKept(),
    m.devicesJoinSetUpStays(),
  ])
    expect(aside.textContent).not.toContain(promise);
  expect(unansweredOf(bridge)).toEqual([]);
});
