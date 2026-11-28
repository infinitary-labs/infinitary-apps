import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { box, boxLocator, draft, HALF_TYPED, openOverlay, TITLES } from "./overlayMessage";
import { stageAtRest } from "./stack";

/**
 * The first mate's message box in the card overlay (docs/card-overlay.md,
 * "The message box"). The captain: "also, we should bring first mate chat
 * input there as well", and on the plan, "Message box stays: the key opens
 * it even when no card waits".
 * With cards, the box opens with the window's unsent words under the pager,
 * sends with the shown card's id and draws the newest round, which opens nothing.
 */

test("with cards, the box opens with the window's words under the pager, sends with the shown card, and draws the round", async () => {
  const bridge = await openOverlay(TITLES, draft(HALF_TYPED));
  await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();
  await stageAtRest();

  // Section: the window's unsent words are in the box, which sits under the pager.
  await expect.poll(() => box()?.value).toBe(HALF_TYPED);
  const pager = document.querySelector<HTMLElement>("[data-card-pager]");
  const message = document.querySelector<HTMLElement>("[data-overlay-message]");
  if (!pager || !message) throw new Error("The overlay drew no pager or no box");
  expect(message.getBoundingClientRect().top - pager.getBoundingClientRect().bottom).toBeCloseTo(
    12,
    0,
  );

  // Section: the send carries the words and the card on screen; nothing shows until it arrives.
  await userEvent.click(boxLocator());
  await userEvent.keyboard(" backups{Enter}");
  await expect
    .poll(() => bridge.requests("inf:converse").map(([turn]) => turn))
    .toEqual([
      expect.objectContaining({ text: `${HALF_TYPED} backups`, visibleCardId: "stays-1" }),
    ]);
  expect(document.querySelector("[data-overlay-round]")).toBeNull();
  bridge.push("inf:events", [
    { type: "user_turn", text: `${HALF_TYPED} backups`, sentAt: Date.now() },
    { type: "firstmate_state", busy: true },
  ]);
  await expect
    .poll(() => document.querySelector("[data-overlay-round]")?.textContent)
    .toContain("backups");
  bridge.push("inf:events", [
    { type: "firstmate_reply", text: "I started a crewmate on the backups." },
    { type: "firstmate_state", busy: false },
  ]);
  await expect
    .poll(() => document.querySelector("[data-overlay-round]")?.textContent)
    .toContain("I started a crewmate on the backups.");
  // The round opens nothing: the conversation stays in the window.
  expect(document.querySelector("[data-overlay-round] button")).toBeNull();
  expect(bridge.requests("inf:overlay:hide")).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
