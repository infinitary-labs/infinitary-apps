import { CARD_OVERLAY_ATTRIBUTE } from "@shared/cardOverlay";
import type { Card } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { answerStack, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * The card overlay's stack stays up after a card closes (docs/card-overlay.md,
 * "Going back"). The captain, after using it a few times: "the card stack
 * should stay after closing a card. it should go away only when the last
 * card is gone or when the user dismisses the overlay." A choice on the first
 * of two cards brings up the second in the same panel; the choice on the
 * last one sends the panel away, once.
 */

const TITLES = ["Merge the login fix", "Turn on nightly backups"];
/** The panel's width (`OVERLAY_WIDTH`, src/shared/cardOverlay.ts) and a laptop display's work area. */
const PANEL = { width: 592, height: 945 };

test("a choice on one of two cards brings up the other, and the choice on the last sends the overlay away once", async () => {
  const home = await seededHome({ titles: TITLES });
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  // The core takes an answered card off its list and tells every view.
  let cards = home["inf:cards:list"] as Card[];
  bridge.answer("inf:cards:act", (id) => {
    cards = cards.filter((card) => card.id !== id);
    const held = cards;
    bridge.answer("inf:cards:list", held);
    setTimeout(() => bridge.push("inf:cards", held));
    return {};
  });
  bridge.answer("inf:overlay:start", { cardId: null });
  bridge.answer("inf:overlay:ready", { ok: true });
  bridge.answer("inf:overlay:pointer", { ok: true });
  bridge.answer("inf:overlay:wide", { ok: true });
  bridge.answer("inf:overlay:hide", { ok: true });
  document.documentElement.setAttribute(CARD_OVERLAY_ATTRIBUTE, "");
  await page.viewport(PANEL.width, PANEL.height);
  await openWindow(bridge);
  const approve = () => page.getByRole("button", { name: "Approve", exact: true });

  // Section: the first choice leaves the overlay up, on the other card.
  await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();
  await stageAtRest();
  await userEvent.click(approve());
  await expect.element(page.getByRole("region", { name: TITLES[1], exact: true })).toBeVisible();
  await stageAtRest();
  expect(bridge.requests("inf:cards:act").map(([id]) => id)).toEqual(["stays-1"]);
  expect(bridge.requests("inf:overlay:hide")).toEqual([]);

  // Section: the choice on the last card sends the overlay away, once.
  await userEvent.click(approve());
  await expect.poll(() => bridge.requests("inf:overlay:hide").length).toBe(1);
  expect(bridge.requests("inf:cards:act").map(([id]) => id)).toEqual(["stays-1", "stays-2"]);
  await stageAtRest();
  expect(bridge.requests("inf:overlay:hide")).toHaveLength(1);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
