import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { GATE_HOME_TITLE, gateIntro } from "../../src/renderer/src/app/firstRunGateWords";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { intersects } from "./layout";
import { openSize, openWindow } from "./window";

/**
 * The first launch (captain decisions 2026-09-19; docs/first-launch.md): the
 * gate is derived, never flagged, so it returns once the last account that
 * could answer the first mate is removed - over a conversation, whose last
 * turn hangs above the input. The gate's band, its words and its provider
 * chips, ends above that last turn, at the smallest window and at a common
 * one, so the caption never draws under those words.
 */

const ASK = "Please pause the work for now";
const REPLY = "Paused. Nothing new starts until you say so.";

/** The last turn above the input. */
const LAST_TURN = "[data-last-turn]";

/** The gate's band while it is open. */
const OPEN_GATE = '[data-first-run-gate="open"]';

/** Returns once nothing that moves `element`, or a box holding it, is still running. */
async function atRest(element: Element): Promise<void> {
  await Promise.all(
    document
      .getAnimations()
      .filter((motion) => {
        const effect = motion.effect;
        return (
          effect instanceof KeyframeEffect &&
          effect.target?.contains(element) === true &&
          effect.getComputedTiming().endTime !== Number.POSITIVE_INFINITY
        );
      })
      .map((motion) => motion.finished.catch(() => undefined)),
  );
}

test("a gate that reopens over a conversation keeps its words and chips clear of the last turn", async () => {
  const home = await seededHome({ ask: ASK, reply: REPLY });
  // The home's own reading: nothing in it can answer the first mate.
  const reopened = home["inf:app:first-run"];
  if (!reopened || typeof reopened === "function") throw new Error("The home answers no first run");
  expect(reopened.gateOpen).toBe(true);
  // The same home while a model could still answer: the conversation, with no gate.
  const bridge = fakeBridge(subscribed(home));
  await openSize();
  await openWindow(bridge);

  // Section: the conversation's last turn shows above the input.
  await expect.poll(() => document.querySelector(LAST_TURN)).not.toBeNull();
  const lane = document.querySelector<HTMLElement>(LAST_TURN) as HTMLElement;
  await expect.element(lane).toBeVisible();
  const words = [...lane.querySelectorAll("[data-last-turn-words]")].map(
    (each) => each.textContent,
  );
  expect(words).toEqual([ASK, REPLY]);
  expect(document.querySelector("[data-first-run-gate]")).toBeNull();

  // Section: the last account is removed. The core reads the gate open again
  // and tells the window the models changed, and the window reads it.
  bridge.answer("inf:app:first-run", reopened);
  bridge.push("inf:models:changed", { ok: true });
  await expect.poll(() => document.querySelector(OPEN_GATE)).not.toBeNull();
  const gate = document.querySelector<HTMLElement>(OPEN_GATE) as HTMLElement;
  await expect.element(gate).toBeVisible();
  const part = (selector: string) => gate.querySelector<HTMLElement>(selector) as HTMLElement;
  await expect.element(part("[data-gate-title]")).toHaveTextContent(GATE_HOME_TITLE);
  await expect.element(part("[data-mac-choice]")).toHaveTextContent(gateIntro());
  await expect
    .poll(() => gate.querySelectorAll("[data-connect-provider]").length)
    .toBeGreaterThan(0);
  expect(document.querySelector(LAST_TURN)).toBe(lane);

  // Section: the band stays clear of the last turn at each window size.
  for (const size of [SMALLEST_WINDOW, { width: 1280, height: 800 }]) {
    await page.viewport(size.width, size.height);
    await atRest(gate);
    // The band scrolls what does not fit, so its own box is what shows.
    const shown = gate.getBoundingClientRect();
    const turn = lane.getBoundingClientRect();
    expect(turn.height, `the last turn shows at ${size.width}x${size.height}`).toBeGreaterThan(0);
    expect(intersects(shown, turn), `${size.width}x${size.height}`).toBe(false);
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
