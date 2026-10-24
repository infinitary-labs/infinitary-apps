import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  KEYBOARD_CARD_TITLES,
  KEYBOARD_CARDS_PROMPT_MARKER,
  keyboardCards,
} from "./scenarios/keyboardCards";
import { pager, showCard, shownCard, shownEntry, stagePrepared } from "./stack";
import { pressWindowKey } from "./windowKeys";

/**
 * Holds the shown card's reveal - the stage's own move, not the opacity
 * transition the entry also runs - in flight until paging interrupts it: no
 * sleep or wall-clock race decides whether we exercised the cancellation path.
 */
async function holdReveal(page: Page): Promise<void> {
  await shownEntry(page).evaluate((entry) => {
    const reveal = entry
      .getAnimations()
      .find(
        (animation) =>
          animation.playState === "running" &&
          !(animation instanceof CSSTransition) &&
          !(animation instanceof CSSAnimation),
      );
    if (!reveal) throw new Error("the selected card's reveal must still be running");
    reveal.pause();
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
    await showCard(page, KEYBOARD_CARD_TITLES.inline);
    await holdReveal(page);
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
 * the mock provider's keyboard cards. The completion signal: the shown card's
 * successor is prepared. Platform and shared resources: none beyond the
 * hermetic launch.
 */
test("a page back prepares the successor after interrupting a reveal whose drawing had already gone", async () => {
  const { app, page, close } = await launchApp({ withMockProvider: true });
  try {
    const prompt = promptInput(page);
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${KEYBOARD_CARDS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
    await showCard(page, KEYBOARD_CARD_TITLES.served);
    await stagePrepared(page);
    await showCard(page, KEYBOARD_CARD_TITLES.inline);
    await holdReveal(page);
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
