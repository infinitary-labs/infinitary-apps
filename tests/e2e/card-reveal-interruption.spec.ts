import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  KEYBOARD_CARD_TITLES,
  KEYBOARD_CARDS_PROMPT_MARKER,
  keyboardCards,
} from "./scenarios/keyboardCards";
import { pager, SHOWN_ENTRY, showCard, shownCard, shownEntry, stagePrepared } from "./stack";
import { pressWindowKey } from "./windowKeys";

/**
 * Holds the reveal of the card the stage shows next - the stage's own move,
 * not the opacity transition the entry also runs - from its first frame
 * until paging interrupts it. It is armed before the page that starts the
 * reveal: a reveal looked for once the card was up had sometimes finished
 * already, with ten of these journeys running at once, so no sleep or
 * wall-clock race decides whether we exercised the cancellation path.
 */
async function holdNextReveal(page: Page): Promise<void> {
  await page.evaluate((shown) => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.matches(shown)) {
        Element.prototype.animate = animate;
        animation.pause();
      }
      return animation;
    };
  }, SHOWN_ENTRY);
}

/** The shown card's own reveal is the one held, still in flight. */
async function expectRevealHeld(page: Page): Promise<void> {
  await shownEntry(page).evaluate((entry) => {
    const held = entry
      .getAnimations()
      .some(
        (animation) =>
          animation.playState === "paused" &&
          !(animation instanceof CSSTransition) &&
          !(animation instanceof CSSAnimation),
      );
    if (!held) throw new Error("the selected card's reveal must be held in flight");
  });
}

// A return to a drawing still held on screen starts no new reveal. Cancelling
// its earlier reveal must release the preparation gate, not leave it waiting
// for the finish event of an animation that no longer exists.
test("a fast page back prepares the successor after interrupting the shown card's reveal", async () => {
  const { app, page, close } = await launchApp({
    scenarios: [keyboardCards],
    withMockProvider: true,
  });
  try {
    const prompt = promptInput(page);
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${KEYBOARD_CARDS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
    await showCard(page, KEYBOARD_CARD_TITLES.served);
    await stagePrepared(page);
    await holdNextReveal(page);
    await showCard(page, KEYBOARD_CARD_TITLES.inline);
    await expectRevealHeld(page);
    const position = Number(
      await page.locator("[data-card-pager]").getAttribute("data-pager-position"),
    );
    await pressWindowKey(app, position === 1 ? "]" : "[", ["meta", "shift"]);
    await expect(page.locator("[data-card-pager]")).toHaveAttribute(
      "data-pager-position",
      String(position === 1 ? 2 : 1),
    );
    await pressWindowKey(app, position === 1 ? "[" : "]", ["meta", "shift"]);
    await expect(shownCard(page, KEYBOARD_CARD_TITLES.inline)).toBeVisible();
    await stagePrepared(page);
  } finally {
    await close();
  }
});

/**
 * INF-1154 (card-reveal-interruption.spec.ts:15 in the first run of journeys
 * run 40106791569: the successor was never prepared): the drawing a page
 * replaces can be gone while the incoming card is still coming in, and the
 * next selection must cut that reveal short too. Here the reveal is held and
 * the page waits for the drawing to go before paging away and back, so the
 * order the failing run met under load is the order of every run. The data:
 * the keyboard-cards scenario's two notes. The completion signal: the shown
 * card's successor is prepared. Platform and shared resources: none beyond
 * the hermetic launch.
 */
test("a page back prepares the successor after interrupting a reveal whose drawing had already gone", async () => {
  const { app, page, close } = await launchApp({
    scenarios: [keyboardCards],
    withMockProvider: true,
  });
  try {
    const prompt = promptInput(page);
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${KEYBOARD_CARDS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
    await showCard(page, KEYBOARD_CARD_TITLES.served);
    await stagePrepared(page);
    await holdNextReveal(page);
    await showCard(page, KEYBOARD_CARD_TITLES.inline);
    await expectRevealHeld(page);
    // The drawing the page replaced has gone; the reveal is still in flight.
    await expect(page.locator('[data-card-layer] [data-stage-entry="outgoing"]')).toHaveCount(0);
    const position = Number(
      await page.locator("[data-card-pager]").getAttribute("data-pager-position"),
    );
    await pressWindowKey(app, position === 1 ? "]" : "[", ["meta", "shift"]);
    await expect(page.locator("[data-card-pager]")).toHaveAttribute(
      "data-pager-position",
      String(position === 1 ? 2 : 1),
    );
    await pressWindowKey(app, position === 1 ? "[" : "]", ["meta", "shift"]);
    await expect(shownCard(page, KEYBOARD_CARD_TITLES.inline)).toBeVisible();
    await stagePrepared(page);
  } finally {
    await close();
  }
});
