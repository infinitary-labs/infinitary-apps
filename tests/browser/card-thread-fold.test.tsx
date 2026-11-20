import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { messageCountWords, threadCueLabel } from "../../src/renderer/src/cards/threadWords";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, SHOWN_ENTRY } from "./stack";

import { openWindow } from "./window";

/**
 * A card's thread folded into the card's foot and opened beside it again
 * from the keyboard (cards as threads; the captain's rule that every feature
 * works from the keyboard): folding it puts focus on the line that opens it,
 * and opening it puts focus on what folds it. Guardrails for INF-2625's
 * renderer piece, which moves this code out of HomeScreen.tsx: they hold
 * what a person sees before and after the move.
 */

const TITLE = "Pick the release window";

/** The shown card's part `selector`, or null while it draws none. */
const shown = (selector: string) =>
  document.querySelector<HTMLElement>(`${SHOWN_ENTRY} ${selector}`);

test("a card's thread folds and opens again by keys, focus following what undoes each", async () => {
  const home = subscribed(await seededHome({ title: TITLE }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await page.viewport(1280, 820);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();

  // Section: the thread opens beside the card, with its two lines.
  await expect.poll(() => shown("[data-thread-collapse]")).not.toBeNull();
  expect(shown("[data-thread-cue]")).toBeNull();

  // Section: folding it by key leaves the cue at the card's foot, focused.
  (shown("[data-thread-collapse]") as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => shown("[data-thread-cue]")).not.toBeNull();
  expect(shown("[data-thread-collapse]")).toBeNull();
  expect(shown("[data-thread-cue]")?.getAttribute("aria-label")).toBe(
    threadCueLabel(messageCountWords(2), false),
  );
  await expect.poll(() => document.activeElement === shown("[data-thread-cue]")).toBe(true);

  // Section: opening it by key puts it beside the card again, focus on its fold.
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => shown("[data-thread-collapse]")).not.toBeNull();
  expect(shown("[data-thread-cue]")).toBeNull();
  await expect.poll(() => document.activeElement === shown("[data-thread-collapse]")).toBe(true);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
