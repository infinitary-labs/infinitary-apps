import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import {
  PUT_ASIDE_LABEL,
  PUT_EVERY_CARD_ASIDE_LABEL,
} from "../../src/renderer/src/design/cards/cardSizeWords";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { clickInBody, SHOWN_ENTRY, showCard, shownCard, shownEntry } from "./stack";
import { boardCard, boardsOnStage } from "./taskBoard";
import { focusOn, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * INF-4002, the captain's ask "do we have a keybind to minimize all cards?"
 * and their answers to its plan: one key both ways (⌥⇧⌘M puts every card
 * aside, and on an empty stage brings them all back), and a ⌥-click on a
 * card's minus that does the same, its label saying so while ⌥ is held.
 * Data: a first mate decision with a picked answer and a first mate note in
 * a private home, with the task board open in front of them. Signal: the
 * stage's entries, the saved cards' put-aside state, the main message's
 * focus and words, and the picked answer. Hidden Electron with the mock
 * provider; no Mac-only resource, sign-in or real data.
 */

const DECISION = "Choose the launch window";
const NOTE = "The launch checklist is ready";
const WORDS = "Keep the review beside the launch";

/** Which of the two cards the owner holds put aside, by id. */
function putAside(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(async () =>
    Object.fromEntries(
      (await window.infinitary.cards.list()).map((card) => [card.id, card.minimized === true]),
    ),
  );
}

test("⌥⇧⌘M puts every card aside in one press and brings them back on an empty stage", async () => {
  test.setTimeout(150_000);
  const userDataDir = scratchDir("infinitary-minimize-all-");
  const db = openDatabase(userDataDir);
  try {
    const store = new CardStore(db);
    store.upsert({
      id: "launch-choice",
      author: "firstmate",
      meta: "firstmate",
      title: DECISION,
      priority: 20,
      status: "ready",
      createdAt: Date.now(),
      body: '<p>Keep the launch and its review together.</p><fieldset><legend>When should we launch?</legend><label><input type="radio" name="launch" value="tuesday"> Tuesday</label><label><input type="radio" name="launch" value="friday"> Friday</label></fieldset>',
      actions: [{ id: "go", label: "Use this window", default: true }],
    });
    store.upsert({
      id: "launch-note",
      author: "firstmate",
      meta: "firstmate",
      title: NOTE,
      priority: 20,
      status: "ready",
      createdAt: Date.now() + 1,
      body: "<p>Every item on the launch checklist has an owner.</p>",
      actions: [],
    });
  } finally {
    db.close();
  }
  const { app, page, close } = await launchApp({ userDataDir, withMockProvider: true });
  const prompt = promptInput(page);
  const answer = () => cardBody(page, DECISION).getByRole("radio", { name: "Friday", exact: true });
  try {
    await test.step("a decision with a pick, a note and the task board are on the stage", async () => {
      await showCard(page, DECISION);
      await clickInBody(answer());
      await expect(answer()).toBeChecked();
      await runFromSearch(app, page, "panel:now/board");
      await expect(boardCard(page)).toBeVisible();
      await prompt.fill(WORDS);
      await focusOn(prompt);
    });

    await test.step("one press from the main message empties the stage and keeps the caret and words", async () => {
      await pressWindowKey(app, "m", ["meta", "alt", "shift"]);
      await expect(page.locator(SHOWN_ENTRY)).toHaveCount(0);
      await expect(boardsOnStage(page)).toHaveCount(0);
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue(WORDS);
      await expect
        .poll(() => putAside(page))
        .toEqual({ "launch-choice": true, "launch-note": true });
    });

    await test.step("the same press on the empty stage brings both cards back, the pick kept", async () => {
      await pressWindowKey(app, "m", ["meta", "alt", "shift"]);
      await expect
        .poll(() => putAside(page))
        .toEqual({ "launch-choice": false, "launch-note": false });
      await showCard(page, DECISION);
      await expect(answer()).toBeChecked();
      await showCard(page, NOTE);
      // The board was a view of this window: it hid, and nothing brings it back.
      await expect(boardsOnStage(page)).toHaveCount(0);
    });

    await test.step("with ⌥ held the minus says Put every card aside, and its click does it", async () => {
      const minus = shownEntry(page).locator("[data-card-leave]");
      const label = page.locator("[data-icon-label]");
      await expect(minus).toHaveAccessibleName(PUT_ASIDE_LABEL);
      await focusOn(prompt);
      await minus.hover();
      await expect(label).toContainText(PUT_ASIDE_LABEL);
      // Pressed while the pointer rests: the shown label changes its words where it stands.
      await page.keyboard.down("Alt");
      await expect(minus).toHaveAccessibleName(PUT_EVERY_CARD_ASIDE_LABEL);
      await expect(label).toContainText(PUT_EVERY_CARD_ASIDE_LABEL);
      await minus.click({ modifiers: ["Alt"] });
      await page.keyboard.up("Alt");
      await expect(page.locator(SHOWN_ENTRY)).toHaveCount(0);
      await expect(shownCard(page, NOTE)).toHaveCount(0);
      await expect
        .poll(() => putAside(page))
        .toEqual({ "launch-choice": true, "launch-note": true });
    });
  } finally {
    await close();
  }
});
