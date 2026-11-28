import { CARD_OVERLAY_ATTRIBUTE } from "@shared/cardOverlay";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { shownEntry, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * A card in the overlay opens at its window width, hugging the panel's
 * trailing edge (docs/card-overlay.md, "The panel"). The captain saw a
 * tradeoff card the window shows at 800 px squeezed to 506 px over a game;
 * the approved plan lets the panel take up to half the screen and every
 * card keep the width it has in the window, with the panel's spare room on
 * the card's leading side, clear for clicks.
 */

const WIDE = "Which way should the panel grow";
const SHORT = "The overlay is on";
const CHART = `
  <fieldset>
    <legend>How much of the screen may one card take?</legend>
    <label><input type="radio" name="share" value="third"> A third</label>
    <label><input type="radio" name="share" value="half" data-inf-recommended> Half</label>
    <label><input type="radio" name="share" value="window"> As wide as in the window</label>
    <label><input type="radio" name="share" value="other" data-inf-write-in> Something else</label>
    <table data-inf-tradeoff>
      <tr><td></td><th>Game in view</th><th>Room for the card</th><th>Laptops</th><th>Ship fast</th></tr>
      <tr data-inf-option="third"><td>A third</td><td data-inf-level="high">most</td>
        <td data-inf-level="medium">some</td><td data-inf-level="low">stay small</td><td data-inf-level="high">small</td></tr>
      <tr data-inf-option="half"><td>Half</td><td data-inf-level="medium">less</td>
        <td data-inf-level="high">most</td><td data-inf-level="high">wider</td><td data-inf-level="high">small</td></tr>
      <tr data-inf-option="window"><td>As in the window</td><td data-inf-level="low">least</td>
        <td data-inf-level="high">all of it</td><td data-inf-level="high">wider</td><td data-inf-level="medium">a cap</td></tr>
    </table>
  </fieldset>`;
const NOTES = [
  { title: WIDE, body: `<p>The overlay's panel can grow with the screen.</p>${CHART}` },
  { title: SHORT, body: "<p>Press the key again to hide it.</p>" },
];
/** The window's widths for these two cards (`CARD_SIZES` wide and regular). */
const WIDE_PX = 800;
const REGULAR_PX = 560;
/** The stage's air between the card and the panel's trailing edge: half its 32 px margin. */
const TRAILING_AIR = 16;
/**
 * A 2560-point display at a 110% Size setting, the captain's: half the
 * screen is a 1280-point panel, 1164 of the page's own pixels, and the
 * work area's 1415 points under the menu bar are 1286 of them.
 */
const PANEL = { width: 1164, height: 1286 };

async function show(title: string): Promise<HTMLElement> {
  await expect.element(page.getByRole("region", { name: title, exact: true })).toBeVisible();
  await stageAtRest();
  const card = shownEntry();
  if (!card) throw new Error(`The overlay shows no card for ${title}`);
  return card;
}

function expectPlace(card: HTMLElement, width: number, rightToLeft: boolean, which: string) {
  const box = card.getBoundingClientRect();
  expect(Math.round(box.width), `${which}'s width`).toBe(width);
  const air = rightToLeft ? box.left : PANEL.width - box.right;
  expect(Math.round(air), `${which} hugs the trailing edge`).toBe(TRAILING_AIR);
}

test("each card opens in the overlay at its window width, hugging the panel's trailing edge", async () => {
  const home = await seededHome({ notes: NOTES });
  const bridge = fakeBridge(home);
  bridge.answer("inf:overlay:start", { cardId: null });
  bridge.answer("inf:overlay:ready", { ok: true });
  bridge.answer("inf:overlay:pointer", { ok: true });
  bridge.answer("inf:overlay:wide", { ok: true });
  bridge.answer("inf:overlay:hide", { ok: true });
  document.documentElement.setAttribute(CARD_OVERLAY_ATTRIBUTE, "");
  await page.viewport(PANEL.width, PANEL.height);
  await openWindow(bridge);

  for (const rightToLeft of [false, true]) {
    document.documentElement.setAttribute("dir", rightToLeft ? "rtl" : "ltr");
    const side = rightToLeft ? "in a right-to-left language" : "left to right";
    expectPlace(await show(WIDE), WIDE_PX, rightToLeft, `the tradeoff card, ${side}`);
    await userEvent.click(page.getByRole("button", { name: "Next card", exact: true }));
    expectPlace(await show(SHORT), REGULAR_PX, rightToLeft, `the short note, ${side}`);
    await userEvent.click(page.getByRole("button", { name: "Previous card", exact: true }));
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
