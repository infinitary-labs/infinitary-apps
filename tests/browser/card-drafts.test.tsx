import type { CardAction } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { draftStandIn, seededHome, subscribed } from "./freshHome";
import { bodyDrawn, inCardBody, inShown, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Unsent picks follow you (INF-5446). The captain's ask: "it would be cool if
 * the answers you selected on cards showed up on other devices too (like if
 * you don't finish the card completely)", and "make sure the words are not
 * literally resending on every keystroke". Against a real home holding the
 * picks and words another window left on the card, the window shows them
 * when it opens, shows another window's pick as it arrives, and sends its own
 * pick and words once the captain pauses, never key by key.
 */

const CARD_ID = "card-drafts";
const TITLE = "Choose where the survey starts";
const ACTIONS: CardAction[] = [{ id: "go", label: "Start the survey", default: true }];
const BODY = `
  <fieldset><legend>Which harbour?</legend>
    <label><input type="radio" name="harbour" value="north"> North Basin</label>
    <label><input type="radio" name="harbour" value="south"> South Basin</label>
  </fieldset>
  <label><input id="tide" type="checkbox" name="tide" value="yes"> Keep the tide table</label>
  <label>Notes for the crew <input id="note" type="text" name="crew_note"></label>`;
const SOUTH: FrameAnswer = {
  name: "harbour",
  values: ["south"],
  labels: ["South Basin"],
  changed: true,
};
const NORTH: FrameAnswer = { ...SOUTH, values: ["north"], labels: ["North Basin"] };
const LEFT_WORDS = "Start after the morning tide";
const TYPED = " please";

const checked = (value: string) =>
  inCardBody(
    TITLE,
    (picked) =>
      (document.querySelector(`input[name="harbour"][value="${picked}"]`) as HTMLInputElement)
        .checked,
    value,
  );

test("a card's unsent picks and words follow the captain between windows, sent once they pause, never over what is being typed", async () => {
  const home = subscribed(
    await seededHome({
      title: TITLE,
      body: BODY,
      actions: ACTIONS,
      answers: [SOUTH],
      words: LEFT_WORDS,
    }),
  );
  const saved = home["inf:cards:drafts"];
  if (!Array.isArray(saved) || !saved[0]) throw new Error("The seeded home read no draft");
  // The home as it keeps the card's draft, which the test also changes as another window.
  const drafts = draftStandIn(saved);
  const bridge = fakeBridge(home);
  bridge.answer("inf:cards:seen-update", { ok: true });
  bridge.answer("inf:cards:draft", drafts.change);
  await openSize();
  await openWindow(bridge);
  await bodyDrawn(TITLE);
  await stageAtRest();

  // Section: the picks and words another window left show as the window opens.
  await expect.poll(() => checked("south")).toBe(true);
  const field = () => inShown(`[data-card-reply="${CARD_ID}"] textarea`) as HTMLTextAreaElement;
  await expect.poll(() => field().value).toBe(LEFT_WORDS);
  expect(bridge.requests("inf:cards:draft")).toEqual([]);

  // Section: another window's pick shows here as it arrives.
  const north = drafts.elsewhere(CARD_ID, { answers: [NORTH] });
  bridge.push("inf:cards:draft", north);
  await expect.poll(() => checked("north")).toBe(true);
  expect(bridge.requests("inf:cards:draft")).toEqual([]);

  // Section: a pick here goes once the captain pauses, naming the revision it saw.
  const seen = north.revision;
  await inCardBody(TITLE, () => (document.getElementById("tide") as HTMLInputElement).click());
  await expect.poll(() => bridge.requests("inf:cards:draft").length).toBe(1);
  const [cardId, change] = bridge.requests("inf:cards:draft")[0] ?? [];
  expect(cardId).toBe(CARD_ID);
  expect(change?.since).toBe(seen);
  expect(change?.answers?.map((answer) => answer.name)).toEqual(["tide"]);

  // Section: words typed key by key go as one request after the pause.
  await userEvent.click(page.elementLocator(field()));
  await userEvent.keyboard("{End}");
  await userEvent.keyboard(TYPED);
  // Sent key by key, the second request would carry only the first key.
  await expect.poll(() => bridge.requests("inf:cards:draft").length).toBe(2);
  expect(bridge.requests("inf:cards:draft")[1]?.[1]?.words).toBe(LEFT_WORDS + TYPED);

  // Section: another window's words wait while this window's field holds focus.
  expect(document.activeElement).toBe(field());
  bridge.push(
    "inf:cards:draft",
    drafts.elsewhere(CARD_ID, { words: "Words from the other window" }),
  );
  // The field takes nothing while it holds focus; the next change shows that the frame was heard.
  bridge.push("inf:cards:draft", drafts.elsewhere(CARD_ID, { answers: [SOUTH] }));
  await expect.poll(() => checked("south")).toBe(true);
  expect(field().value).toBe(LEFT_WORDS + TYPED);

  // Section: a question being typed into in the body keeps what is typed; the others take the change.
  await inCardBody(TITLE, () => {
    const note = document.getElementById("note") as HTMLInputElement;
    note.focus();
    note.value = "Bring the chart";
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Once what was typed has gone, only the body's own rule keeps the focused question.
  await expect
    .poll(() =>
      bridge
        .requests("inf:cards:draft")
        .some(([, sent]) => sent.answers?.some((answer) => answer.name === "crew_note")),
    )
    .toBe(true);
  const typed: FrameAnswer = {
    name: "crew_note",
    values: ["From the other window"],
    changed: true,
  };
  bridge.push("inf:cards:draft", drafts.elsewhere(CARD_ID, { answers: [NORTH, typed] }));
  await expect.poll(() => checked("north")).toBe(true);
  expect(
    await inCardBody(TITLE, () => (document.getElementById("note") as HTMLInputElement).value),
  ).toBe("Bring the chart");
  expect(bridge.unanswered).toEqual([]);
});
