import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { button, held, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The review of INF-5409: a window beside a first mate started outside it, which it may neither
 * stop nor leave, promises neither that it opens the first mate's computer by itself nor Paste its
 * link or Join by its address, though nothing was done here: the shell's answer says so, and both
 * join chips are unavailable from the mouse and the keyboard, with the line that says why. Before
 * the shell's first answer neither is offered either, and the set-up aside promises nothing, and a
 * later answer that a join works offers
 * both again. While no command runs a pasted link's join alone is offered, since it stops none.
 * The untouched profile's view is join-set-up.test.tsx.
 */

test("beside a first mate started outside the window, an untouched first launch promises no switch or join", async () => {
  const home = freshHome();
  // The shell has not answered yet: whether a join works here is unknown.
  const first = held<{ followed: boolean; follows: boolean; joins: boolean; pastes: boolean }>();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:follow-added", () => first.promise);
  await openSize();
  await openWindow(bridge);
  const setUp = () => shown("[data-join-set-up-chip]");
  await setUp();
  const chips = () =>
    [
      document.querySelector<HTMLButtonElement>("[data-join-chip]"),
      document.querySelector<HTMLButtonElement>("[data-join-address-chip]"),
    ].map((chip) => chip?.disabled);
  // Unknown is not allowed: neither join is offered, and no line says why yet.
  expect(chips()).toEqual([true, true]);
  expect(document.querySelector("[data-join-stays]")).toBeNull();
  // The open aside promises neither a switch nor that this computer keeps its own first mate.
  {
    await userEvent.click(await setUp());
    const aside = await shown("[data-join-set-up]");
    await shown("[data-join-set-up-address]");
    expect(aside.querySelector(".fm-join-waiting[role=status]")?.textContent).toBe("");
    for (const promise of [
      m.devicesJoinSetUpWaiting(),
      m.devicesJoinSetUpKept(),
      m.devicesJoinSetUpStays(),
    ])
      expect(aside.textContent).not.toContain(promise);
    await userEvent.click(button(aside, m.devicesJoinCancel()));
  }
  // The shell runs beside a command this window did not start: it neither follows nor joins.
  bridge.answer("inf:devices:follow-added", {
    followed: false,
    follows: false,
    joins: false,
    pastes: false,
  });
  first.resolve({ followed: false, follows: false, joins: false, pastes: false });
  // The closed group offers neither join: both chips are unavailable, and Tab passes them by.
  await expect
    .poll(() => document.querySelector("[data-join-stays]")?.textContent)
    .toBe(m.devicesJoinStaysBeside());
  const paste = document.querySelector<HTMLButtonElement>("[data-join-chip]");
  const byAddress = document.querySelector<HTMLButtonElement>("[data-join-address-chip]");
  expect([paste?.disabled, byAddress?.disabled]).toEqual([true, true]);
  (await setUp()).focus();
  await userEvent.tab();
  expect([paste, byAddress]).not.toContain(document.activeElement);
  await userEvent.click(await setUp());
  const aside = await shown("[data-join-set-up]");
  await expect
    .poll(() => aside.querySelector(".fm-join-waiting[role=status]")?.textContent)
    .toBe(m.devicesJoinSetUpStays());
  expect(aside.textContent).not.toContain(m.devicesJoinSetUpWaiting());
  expect(aside.textContent).not.toContain(m.devicesJoinSetUpKept());
  await userEvent.click(button(aside, m.devicesJoinCancel()));
  // No command runs and the window's own is about to start: a pasted link joins, stopping none,
  // while Join by its address waits for the command, and no line says this computer stays.
  bridge.answer("inf:devices:follow-added", {
    followed: false,
    follows: false,
    joins: false,
    pastes: true,
  });
  await expect.poll(chips, { timeout: 10_000 }).toEqual([false, true]);
  expect(document.querySelector("[data-join-stays]")).toBeNull();
  // The command beside it ended and the window's own took its place: the shell's next answer
  // offers both joins again, from the keyboard too.
  bridge.answer("inf:devices:follow-added", {
    followed: false,
    follows: true,
    joins: true,
    pastes: true,
  });
  await expect.poll(chips, { timeout: 10_000 }).toEqual([false, false]);
  expect(document.querySelector("[data-join-stays]")).toBeNull();
  (await shown("[data-join-set-up-chip]")).focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(document.querySelector("[data-join-chip]"));
  expect(unansweredOf(bridge)).toEqual([]);
});
