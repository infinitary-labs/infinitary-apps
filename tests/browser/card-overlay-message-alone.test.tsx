import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { box, draft, HALF_TYPED, openOverlay } from "./overlayMessage";

/**
 * The first mate's message box in the card overlay (docs/card-overlay.md,
 * "The message box"). The captain: "also, we should bring first mate chat
 * input there as well", and on the plan, "Message box stays: the key opens
 * it even when no card waits".
 * With no card, the overlay key opens the box alone holding the keys; Escape
 * gives the window its message back and leaves once, sending nothing.
 */

test("with no card, the key opens the box alone with the keys; Escape hands the words back and leaves once without sending", async () => {
  const bridge = await openOverlay([], draft(HALF_TYPED));

  // Section: the box alone is what the panel shows, ready and holding focus.
  await expect.poll(() => bridge.requests("inf:overlay:ready")).toEqual([[{ cards: true }]]);
  expect(document.querySelector("[data-overlay-message-alone]")).not.toBeNull();
  await expect.poll(() => document.activeElement).toBe(box());
  expect(box()?.value).toBe(HALF_TYPED);

  // Section: Escape leaves, giving the window its message back with the words added here.
  await userEvent.keyboard(" more");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => bridge.requests("inf:overlay:hide").length).toBe(1);
  expect(bridge.requests("inf:overlay:hand-back")).toEqual([
    [{ ask: 7, draft: draft(`${HALF_TYPED} more`) }],
  ]);
  expect(bridge.requests("inf:converse")).toEqual([]);
});
