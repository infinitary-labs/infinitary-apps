import type { HomeAtAnswer } from "@shared/homeAt";
import * as m from "@shared/i18n/messages.generated";
import type { JoinAtAnswer } from "@shared/joinByAddress";
import { NEARBY_OFF } from "@shared/nearbyMacs";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { button, gone, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Review findings on the welcome screen's setup over SSH (INF-6207's plan,
 * part 2): leaving the screen while a step runs cancels the setup there,
 * as Cancel does; a stop after something there changed does not say
 * nothing changed, even after Ask again; and Cancel pressed while the first
 * mate there starts ends on it keeping running, with no join until Ask again.
 */

const STARTED: HomeAtAnswer = {
  started: true,
  address: "sam@studio",
  name: "studio",
  lingerOff: false,
  waitsForLogin: false,
  private: true,
};

test("leaving or cancelling the setup stops it there, and a stop after a change claims nothing unchanged", async () => {
  const pending: ((answer: HomeAtAnswer) => void)[] = [];
  const answers: (HomeAtAnswer | "wait")[] = [
    "wait",
    { refused: "failed", step: "send", name: "studio", changed: true },
    { refused: "unreachable", step: "look", name: "studio", reach: { step: "sign-in", port: 22 } },
    "wait",
  ];
  const bridge = fakeBridge({
    ...freshHome(),
    "inf:devices:home-at": () => {
      const next = answers.shift();
      if (next === undefined) throw new Error("No answer left");
      if (next !== "wait") return Promise.resolve(next);
      return new Promise<HomeAtAnswer>((resolve) => {
        pending.push(resolve);
      });
    },
    "inf:devices:home-at-cancel": { ok: true },
    "inf:devices:join-at": (): JoinAtAnswer => ({ refused: "self" }),
    "inf:devices:nearby": NEARBY_OFF,
  });
  await openSize();
  await openWindow(bridge);

  // Section: the welcome's back, pressed while a step runs, cancels the setup there.
  await userEvent.click(await shown('[data-gate-choice="another"]'));
  await userEvent.type(await shown("#home-address"), "sam@studio{Enter}");
  await shown("[data-home-steps]");
  await userEvent.click(await shown('[data-gate-back="another"]'));
  await gone("[data-home-at]");
  await expect.poll(() => bridge.requests("inf:devices:home-at-cancel")).toEqual([["sam@studio"]]);
  pending.shift()?.({ refused: "cancelled", step: "key" });

  // Section: a stop after the Ubuntu package went in has no footer saying nothing changed.
  await userEvent.click(await shown('[data-gate-choice="another"]'));
  await userEvent.type(await shown("#home-address"), "sam@studio{Enter}");
  let stopped = await shown('[data-home-steps="send"] [data-home-stopped]');
  expect(stopped.querySelector("[data-home-left]")).toBeNull();
  // Asked again, the next stop's answer no longer says so, but the change there stands.
  await userEvent.click(button(stopped, m.devicesHomeAskAgain()));
  stopped = await shown('[data-home-steps="look"] [data-home-stopped]');
  expect(stopped.querySelector("[data-home-left]")).toBeNull();

  // Section: Cancel pressed while the first mate there starts ends on it keeping running, with no join.
  await userEvent.click(button(stopped, m.devicesHomeAskAgain()));
  await userEvent.click(await shown("[data-home-cancel]"));
  pending.shift()?.(STARTED);
  const kept = await shown('[data-home-steps="connect"] [data-home-stopped]');
  expect(kept.textContent).toContain(m.devicesHomeKeepsRunning({ computer: "studio" }));
  expect(bridge.requests("inf:devices:join-at")).toEqual([]);
  // Ask again still connects to it.
  await userEvent.click(button(kept, m.devicesHomeAskAgain()));
  await expect
    .poll(() => bridge.requests("inf:devices:join-at").map(([at]) => at))
    .toEqual(["sam@studio"]);
  expect(unansweredOf(bridge)).toEqual([]);
});
