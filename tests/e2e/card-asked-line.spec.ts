import { expect, type Page, test } from "@playwright/test";
import {
  ASKED_SHOW_ALL,
  ASKED_SHOW_LESS,
  askedLabel,
  askedWords,
} from "../../src/renderer/src/cards/askedWords";
import { type LaunchedApp, launchApp } from "./launch";
import { promptInput } from "./prompt";
import { ASKED_TITLES, askedLine, LONG_ASK, SHORT_ASK } from "./scenarios/askedLine";
import { closeOpenCards, shownCard, stageAtRest } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * The "You asked" line (INF-1610, docs/card-authoring.md "The You asked
 * line"): a card about one of the captain's messages shows that message
 * under its title, from the saved message. The captain's words: "the UI
 * showing the captain's ask should be thoughtful about long messages. we
 * obviously don't want to display a whole wall of text there" - so a long
 * message shows two lines and opens by its control, from the keyboard, with
 * its paragraphs, and folds again; a short one has no control.
 */

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
});

async function ask(page: Page, words: string, title: string) {
  await promptInput(page).fill(words);
  await promptInput(page).press("Enter");
  const card = shownCard(page, title);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await stageAtRest(page);
  return card;
}

/** How many lines of text the words element shows. */
const linesShown = (element: HTMLElement) =>
  Math.round(element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight));

test("a card shows the message it answers, folding a long one to two lines", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [askedLine] });
  const { page } = launched;
  const label = askedLabel(Date.now()).split(" · ")[0] as string;

  // A short message shows whole, with when it was sent and no control.
  const short = await ask(page, SHORT_ASK, ASKED_TITLES.short);
  await expect(short.locator("[data-card-asked-label]")).toHaveText(new RegExp(`^${label} · `));
  await expect(short.locator("[data-card-asked-words]")).toContainText(
    askedWords(SHORT_ASK, false),
  );
  await expect(short.locator("[data-card-asked-toggle]")).toHaveCount(0);

  await closeOpenCards(page);

  // A long one shows its start in two lines and offers the rest.
  const long = await ask(page, LONG_ASK, ASKED_TITLES.long);
  const words = long.locator("[data-card-asked-words]");
  const toggle = long.locator("[data-card-asked-toggle]");
  await expect(words).toContainText(askedWords(LONG_ASK, false));
  await expect(toggle).toHaveText(ASKED_SHOW_ALL);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await words.evaluate(linesShown)).toBe(2);
  expect(await words.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  // The control opens the whole message from the keyboard, paragraphs and all.
  await pressKey(toggle, "Enter");
  await expect(toggle).toHaveText(ASKED_SHOW_LESS);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await words.evaluate((element) => (element as HTMLElement).innerText)).toContain(
    askedWords(LONG_ASK, true),
  );
  expect(await words.evaluate(linesShown)).toBeGreaterThan(4);

  // And folds it again.
  await pressKey(toggle, "Enter");
  await expect(toggle).toHaveText(ASKED_SHOW_ALL);
  expect(await words.evaluate(linesShown)).toBe(2);
});
