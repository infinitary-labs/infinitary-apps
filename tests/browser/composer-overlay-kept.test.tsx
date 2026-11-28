import type { MainDraft } from "@shared/overlayDraft";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { messageBox, messageBoxLocator } from "./prompt";
import { openSize, openWindow } from "./window";

/**
 * Words the card overlay kept because no window lent its message
 * (docs/card-overlay.md, "The message box"). On INF-7228's review the captain
 * chose to keep them "for the next overlay opening or window": a window opened
 * afterwards, or one told they are kept, takes them into a box that holds
 * nothing, and never over words of its own.
 */

const draft = (text: string): MainDraft => ({
  text,
  pastes: [],
  attachments: [],
  lastSent: null,
  replacing: null,
});

test("a window takes the overlay's kept words into its empty box, at start and when told, never over its own words", async () => {
  const bridge = fakeBridge(subscribed(freshHome()));
  const kept: MainDraft[] = [draft("Typed in the overlay with no window open")];
  bridge.answer("inf:composer:take-kept", () => kept.shift() ?? null);
  await openSize();
  await openWindow(bridge);

  // Section: the window opened after the overlay went starts with the kept words.
  await expect.poll(() => messageBox()?.value).toBe("Typed in the overlay with no window open");

  // Section: told of more kept words while its box holds words, the window leaves them kept.
  kept.push(draft("Typed in a later overlay"));
  const asked = bridge.requests("inf:composer:take-kept").length;
  bridge.push("inf:composer:kept", {});
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(bridge.requests("inf:composer:take-kept")).toHaveLength(asked);
  expect(messageBox()?.value).toBe("Typed in the overlay with no window open");

  // Section: with its box emptied, the window takes them when told again.
  await userEvent.click(messageBoxLocator());
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}{Backspace}");
  await expect.poll(() => messageBox()?.value).toBe("");
  bridge.push("inf:composer:kept", {});
  await expect.poll(() => messageBox()?.value).toBe("Typed in a later overlay");
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
