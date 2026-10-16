import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";
import {
  KEYBOARD_CARD_TITLES,
  KEYBOARD_CARDS_PROMPT_MARKER,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { pager, showCard, shownCard, shownEntry, stagePrepared } from "./stack";
import { pressWindowKey } from "./windowKeys";

// A return to a drawing still held on screen starts no new reveal. Cancelling
// its earlier reveal must release the preparation gate, not leave it waiting
// for the finish event of an animation that no longer exists.
test("a fast page back prepares the successor after interrupting the shown card's reveal", async () => {
  const { app, page, close } = await launchApp({ withMockProvider: true });
  try {
    const prompt = promptInput(page);
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${KEYBOARD_CARDS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
    await showCard(page, KEYBOARD_CARD_TITLES.served);
    await stagePrepared(page);
    await showCard(page, KEYBOARD_CARD_TITLES.inline);
    // Keep this reveal in flight until paging interrupts it: no sleep or
    // wall-clock race decides whether we exercised the cancellation path.
    await shownEntry(page).evaluate((entry) => {
      const reveal = entry.getAnimations().find((animation) => animation.playState === "running");
      if (!reveal) throw new Error("the selected card's reveal must still be running");
      reveal.pause();
    });
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
