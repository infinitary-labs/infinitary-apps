import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  ASKED_LABELS,
  ASKED_SHOW_ALL,
  ASKED_SHOW_LESS,
  askedLabel,
  askedWords,
} from "../../src/renderer/src/cards/askedWords";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { answerStack, cardLeave, inShown, shownEntry, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * The "You asked" line (INF-1610, docs/card-authoring.md "The You asked
 * line"): a card about one of the captain's messages shows that message
 * under its title, from the saved message. The captain's words: "the UI
 * showing the captain's ask should be thoughtful about long messages. we
 * obviously don't want to display a whole wall of text there" - so a long
 * message shows two lines and opens with its paragraphs, then folds again.
 * INF-1963, the captain: "remove the 'show all' link and instead make the bubble expand on click".
 * The bubble itself takes clicks, Enter and Space; a short one is inert.
 * INF-2326, the captain: "when it comes from an automation, it should just
 * say it's ran by an automation and name which one" - so work an automation
 * filed names it without a bubble, work filed from a click shows the button
 * and what they wrote, and work from a task nobody asked for in words names
 * that task.
 */

/** A short message of the captain's, answered on one card. */
const SHORT_ASK = "what does the port flag do?";

/** A long message of three paragraphs, the kind the line must not show whole. */
const LONG_ASK = [
  "did something change about how we order the cards in the stack? this morning a card I had replied under jumped behind two newer notes, and then the merge card for the footer fix showed up first even though I had been reading the plan card.",
  "I'm not sure whether that's the new reply rule or something else. could you check what changed in the last few days, and whether the order is still the one we agreed on in the design skill?",
  "if it is a regression, please fix it, but keep the minimize behavior as it is.",
].join("\n\n");

const SHORT_TITLE = "It picks the port the app listens on";
const AUTOMATION = { name: "Nightly product audit", title: "Three packages have newer versions" };
const CLICK = {
  card: "Plan for clearer cards",
  choice: "File the picked improvements",
  written: "start them later, not now",
  title: "Filed the picked card improvements",
};
const FROM = {
  parent: "Cut tonight's alpha and report slow and new failures",
  title: "The slow journey now waits on its own signal",
};
const LONG_TITLE = "Yes: a card you replied under keeps its place";

/** How many lines of text the words element shows. */
const linesShown = (element: HTMLElement) =>
  Math.round(element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight));

/** Returns once the card titled `title` is shown and the stage rests. */
async function shownCard(title: string): Promise<void> {
  await expect.element(page.getByRole("region", { name: title, exact: true })).toBeVisible();
  await stageAtRest();
}

test("a card shows the message it answers, folding a long one to two lines", async () => {
  const home = await seededHome({
    short: { ask: SHORT_ASK, title: SHORT_TITLE },
    long: { ask: LONG_ASK, title: LONG_TITLE },
    automation: AUTOMATION,
    click: CLICK,
    from: FROM,
  });
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openSize();
  await openWindow(bridge);
  const label = askedLabel({ at: Date.now() }).split(" · ")[0] as string;

  // A short message shows whole, with when it was sent and an inert bubble.
  await shownCard(SHORT_TITLE);
  expect(inShown("[data-card-asked-label]").textContent).toMatch(new RegExp(`^${label} · `));
  expect(inShown("[data-question-bubble-words]").textContent).toContain(
    askedWords(SHORT_ASK, false),
  );
  expect((inShown("[data-question-bubble]") as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(cardLeave());

  // A long one shows its start in two lines and offers the rest.
  await shownCard(LONG_TITLE);
  const words = inShown("[data-question-bubble-words]");
  const toggle = inShown("[data-question-bubble]");
  expect(words.textContent).toContain(askedWords(LONG_ASK, false));
  await expect.element(toggle).toHaveAccessibleName(ASKED_SHOW_ALL);
  await expect.element(page.getByText(ASKED_SHOW_ALL, { exact: true })).not.toBeInTheDocument();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(linesShown(words)).toBe(2);
  expect(words.scrollHeight > words.clientHeight).toBe(true);

  // A click on the bubble opens the whole message, paragraphs and all.
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAccessibleName(ASKED_SHOW_LESS);
  await expect.element(page.getByText(ASKED_SHOW_LESS, { exact: true })).not.toBeInTheDocument();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(words.innerText).toContain(askedWords(LONG_ASK, true));
  expect(linesShown(words)).toBeGreaterThan(4);

  // Clicking again folds it; the same button keeps Enter and Space operation.
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAccessibleName(ASKED_SHOW_ALL);
  expect(linesShown(words)).toBe(2);
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(toggle);
  await userEvent.keyboard(" ");
  await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
  expect(linesShown(words)).toBe(2);
  const close = () => userEvent.click(cardLeave());
  await close();

  // Work an automation filed names the automation, with no bubble of words.
  await shownCard(AUTOMATION.title);
  expect(inShown("[data-card-asked-label]").textContent).toMatch(
    new RegExp(`^${ASKED_LABELS.automation} · `),
  );
  expect(inShown("[data-card-asked-name]").textContent).toBe(AUTOMATION.name);
  expect(shownEntry()?.querySelector("[data-question-bubble]")).toBeNull();
  await close();

  // Work filed from a click shows the button's words and what was written with
  // it, and names the card the click was on (INF-2744).
  await shownCard(CLICK.title);
  expect(inShown("[data-card-asked-label]").textContent).toMatch(
    new RegExp(`^${ASKED_LABELS.chose} on “${CLICK.card}” · `),
  );
  expect(inShown("[data-question-bubble-words]").textContent).toContain(
    `${CLICK.choice} · ${CLICK.written}`,
  );
  await close();

  // Work from a task nobody asked for in words names that task by key and title.
  await shownCard(FROM.title);
  expect(inShown("[data-card-asked-label]").textContent).toMatch(/^From [A-Z]+-\d+$/);
  expect(inShown("[data-card-asked-name]").textContent).toBe(FROM.parent);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
