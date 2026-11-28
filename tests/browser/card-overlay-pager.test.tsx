import { CARD_OVERLAY_ATTRIBUTE } from "@shared/cardOverlay";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { answerStack, shownEntry, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * The card overlay's pager hangs under its card (docs/card-overlay.md, "The
 * panel"). The captain saw it near the screen's bottom when the overlay
 * opened over another app: it hung under the window's fixed lane, which in
 * the overlay is nearly the panel's whole height. The approved plan puts it
 * 10 px under the card, the hide button just above the card's top corner,
 * and lets a click in the stack's empty boxes through to the app behind.
 * The first mate's message box hangs under the pager, and the card, pager and
 * box are centred together (INF-7222's plan: "centred with card and pager").
 */

const TITLES = ["Overlay card 1", "Overlay card 2", "Overlay card 3"];
/** A short first card and a second one long enough to reach the card's cap on every panel. */
const PARAGRAPHS = [1, 80, 1];
/** The panel's width (`OVERLAY_WIDTH`, src/shared/cardOverlay.ts): a 560 px card and 16 px of air each side. */
const PANEL_WIDTH = 592;
/** Panel heights: a small display, a laptop's and a tall one's work area, where the plan measured 142, 275 and 510 px gaps. */
const PANEL_HEIGHTS = [680, 945, 1415];
/** The pager's distance under the card, px (design skill CardStack). */
const PAGER_GAP = 10;
/** The two peeks above the card, 7 px each (`CARD_PEEK_STEP`). */
const PEEKS = 14;

type Box = { top: number; bottom: number; left: number; right: number };
const box = (element: Element | null | undefined, name: string): Box => {
  if (!element) throw new Error(`The overlay draws no ${name}`);
  const { top, bottom, left, right } = element.getBoundingClientRect();
  return { top, bottom, left, right };
};

/** Moves the pointer to a point as the overlay's page hears it, and returns whether it told main the pointer is over the card. */
function pointerAt(
  bridge: ReturnType<typeof fakeBridge>,
  x: number,
  y: number,
): boolean | undefined {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
  return bridge.requests("inf:overlay:pointer").at(-1)?.[0];
}

/** Reads the shown card's place against its pager, hide button and panel, and where the pointer reaches the app. */
function checkPlace(bridge: ReturnType<typeof fakeBridge>, height: number, which: string) {
  const at = `${which} on a ${height} px panel`;
  const card = box(shownEntry(), "card");
  const pager = box(document.querySelector("[data-card-pager] > div"), "pager");
  const hide = box(document.querySelector("[data-card-overlay-hide]"), "hide button");
  const message = box(document.querySelector("[data-overlay-message]"), "message box");

  expect(Math.round(pager.top - card.bottom), `the pager's gap under ${at}`).toBe(PAGER_GAP);
  expect(message.bottom, `the message box stays inside the panel, ${at}`).toBeLessThanOrEqual(
    height,
  );
  expect(
    Math.abs(card.top - (height - message.bottom)),
    `card, pager and message box are centred together, ${at}`,
  ).toBeLessThanOrEqual(1);
  expect(hide.bottom, `the hide button clears the peeks, ${at}`).toBeLessThan(card.top - PEEKS);
  expect(hide.top, `the hide button stays inside the panel, ${at}`).toBeGreaterThanOrEqual(0);
  expect(Math.round(hide.right), `the hide button lines up with the card's corner, ${at}`).toBe(
    Math.round(card.right),
  );

  // A click off the card reaches the app behind: above it, between it and
  // the pager, beside the pager and under it. The page tells main only of a
  // change, so the pointer comes back onto the card before each point.
  const x = (card.left + card.right) / 2;
  const onCard = () => pointerAt(bridge, x, (card.top + card.bottom) / 2);
  const off: [string, number, number][] = [
    ["above the card", x, card.top - PEEKS - 4],
    ["between the card and the pager", x, card.bottom + PAGER_GAP / 2],
    ["beside the pager", card.left + 4, (pager.top + pager.bottom) / 2],
    ["under the pager", x, pager.bottom + 8],
  ];
  for (const [where, px, py] of off) {
    expect(onCard(), `on the card, before ${where}, ${at}`).toBe(true);
    expect(pointerAt(bridge, px, py), `${where}, ${at}`).toBe(false);
  }
  return card;
}

test("the overlay's pager hangs under its card and the hide button above it, on short and tall panels", async () => {
  const home = await seededHome({ titles: TITLES, paragraphs: PARAGRAPHS });
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  bridge.answer("inf:overlay:start", { cardId: null });
  bridge.answer("inf:overlay:ready", { ok: true });
  bridge.answer("inf:overlay:pointer", { ok: true });
  bridge.answer("inf:overlay:wide", { ok: true });
  bridge.answer("inf:overlay:hide", { ok: true });
  document.documentElement.setAttribute(CARD_OVERLAY_ATTRIBUTE, "");
  await page.viewport(PANEL_WIDTH, PANEL_HEIGHTS[0] ?? 0);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();

  for (const height of PANEL_HEIGHTS) {
    await page.viewport(PANEL_WIDTH, height);
    await stageAtRest();
    checkPlace(bridge, height, "a short card");
    await userEvent.click(page.getByRole("button", { name: "Next card", exact: true }));
    await expect.element(page.getByRole("region", { name: TITLES[1], exact: true })).toBeVisible();
    await stageAtRest();
    const tall = checkPlace(bridge, height, "the tallest card");
    expect(
      tall.bottom - tall.top,
      `the tall card reaches its cap on a ${height} px panel`,
    ).toBeGreaterThan(height / 2);
    await userEvent.click(page.getByRole("button", { name: "Previous card", exact: true }));
    await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
