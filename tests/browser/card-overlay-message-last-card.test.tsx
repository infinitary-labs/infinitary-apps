import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { box, draft, HALF_TYPED, openOverlay, TITLES } from "./overlayMessage";
import { stageAtRest } from "./stack";

/**
 * The first mate's message box in the card overlay (docs/card-overlay.md,
 * "The message box"). The captain: "also, we should bring first mate chat
 * input there as well", and on the plan, "Message box stays: the key opens
 * it even when no card waits".
 * The last card closing leaves the overlay up as the box alone while the box
 * holds words, so they never go unseen, and the box alone takes the keys with
 * its caret after its words, so typing goes on where it stopped. The empty
 * box's leave is card-overlay-stays.test.tsx's.
 */

test("the last card closing with words in the box leaves the box alone up, its caret after the words", async () => {
  const bridge = await openOverlay(TITLES.slice(0, 1), draft(HALF_TYPED));
  await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();
  await stageAtRest();

  // The caret rests at the words' start, so only the box's own move puts it at their end.
  box()?.setSelectionRange(0, 0);

  // Section: with words waiting, the last card's choice leaves the box alone up.
  await userEvent.click(page.getByRole("button", { name: "Approve", exact: true }));
  await expect.poll(() => document.querySelector("[data-overlay-message-alone]")).not.toBeNull();
  await stageAtRest();
  expect(bridge.requests("inf:overlay:hide")).toEqual([]);
  expect(box()?.value).toBe(HALF_TYPED);
  expect(document.activeElement).toBe(box());
  expect([box()?.selectionStart, box()?.selectionEnd]).toEqual([
    HALF_TYPED.length,
    HALF_TYPED.length,
  ]);
});
