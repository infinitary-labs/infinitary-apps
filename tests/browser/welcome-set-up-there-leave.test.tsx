import type { HomeAtAnswer } from "@shared/homeAt";
import { NEARBY_OFF } from "@shared/nearbyMacs";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { gone, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Review findings on the welcome screen's setup over SSH (INF-6207's plan,
 * part 2): leaving the screen while a step runs cancels the setup there,
 * as Cancel does, and a stop after something there changed does not say
 * nothing changed.
 */

test("leaving the setup cancels it there, and a stop after the package went in claims nothing unchanged", async () => {
  let answer = (_answer: HomeAtAnswer) => {};
  let calls = 0;
  const bridge = fakeBridge({
    ...freshHome(),
    "inf:devices:home-at": () => {
      calls += 1;
      if (calls > 1)
        return Promise.resolve<HomeAtAnswer>({
          refused: "failed",
          step: "send",
          name: "studio",
          changed: true,
        });
      return new Promise<HomeAtAnswer>((resolve) => {
        answer = resolve;
      });
    },
    "inf:devices:home-at-cancel": { ok: true },
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
  answer({ refused: "cancelled", step: "key" });

  // Section: a stop after the Ubuntu package went in has no footer saying nothing changed.
  await userEvent.click(await shown('[data-gate-choice="another"]'));
  await userEvent.type(await shown("#home-address"), "sam@studio{Enter}");
  const stopped = await shown("[data-home-stopped]");
  expect(document.querySelector('[data-home-step="send"]')?.getAttribute("data-state")).toBe(
    "stopped",
  );
  expect(stopped.querySelector("[data-home-left]")).toBeNull();
  expect(unansweredOf(bridge)).toEqual([]);
});
