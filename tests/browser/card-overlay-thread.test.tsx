import { CARD_OVERLAY_ATTRIBUTE } from "@shared/cardOverlay";
import type { CardMessage } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { draftStandIn, seededHome } from "./freshHome";
import { answerStack, inShown, SHOWN_ENTRY, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * A reply sent through a card in the card overlay shows in the card's thread
 * (docs/card-overlay.md, "The panel"). The captain: "the chat thread on cards
 * don't show when i reply through the card in the overlay". The overlay's
 * narrow panel holds a card's thread in place, behind the card's `card` ·
 * `thread · N` control, which stayed on the card after a reply. Escape still
 * sends the overlay away with the card waiting, answering nothing.
 */

const TITLES = ["Merge the login fix", "Turn on nightly backups"];
const CARD_ID = "stays-1";
/** The panel's width (`OVERLAY_WIDTH`, src/shared/cardOverlay.ts) and a laptop display's work area. */
const PANEL = { width: 592, height: 945 };
const REPLY = "Wait until the billing change is in.";
const ANSWER = "Holding it until billing merges.";

const shownMessages = () =>
  [...document.querySelectorAll<HTMLElement>(`${SHOWN_ENTRY} [data-thread-message]`)].map(
    (line) => line.textContent ?? "",
  );

test("a reply in the overlay shows in the card's thread, and so does its answer", async () => {
  const home = await seededHome({ titles: TITLES });
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  // The core keeps the captain's words on the card's thread and answers the thread as it stands.
  const captain: CardMessage = { id: 1, cardId: CARD_ID, who: "captain", text: REPLY, at: 1 };
  const answer: CardMessage = { id: 2, cardId: CARD_ID, who: "firstmate", text: ANSWER, at: 2 };
  bridge.answer("inf:cards:reply", () => ({ cardId: CARD_ID, messages: [captain] }));
  bridge.answer("inf:cards:draft", draftStandIn([]).change);
  bridge.answer("inf:overlay:start", { cardId: null });
  bridge.answer("inf:overlay:ready", { ok: true });
  bridge.answer("inf:overlay:pointer", { ok: true });
  bridge.answer("inf:overlay:wide", { ok: true });
  bridge.answer("inf:overlay:hide", { ok: true });
  document.documentElement.setAttribute(CARD_OVERLAY_ATTRIBUTE, "");
  await page.viewport(PANEL.width, PANEL.height);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();
  await stageAtRest();

  // Section: the reply sent from the card's field shows in its thread at once.
  const field = inShown("[data-card-reply] textarea");
  await userEvent.click(field);
  await userEvent.keyboard(REPLY);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => bridge.requests("inf:cards:reply").length).toBe(1);
  await expect.poll(shownMessages).toEqual([expect.stringContaining(REPLY)]);
  await expect.element(page.getByRole("button", { name: "thread · 1", exact: true })).toBeVisible();

  // Section: back on the card, the author's answer brings the thread into view again.
  await userEvent.click(page.getByRole("button", { name: "card", exact: true }));
  await expect.poll(shownMessages).toEqual([]);
  bridge.push("inf:cards:thread", { cardId: CARD_ID, messages: [captain, answer] });
  await expect
    .poll(shownMessages)
    .toEqual([expect.stringContaining(REPLY), expect.stringContaining(ANSWER)]);

  // Section: Escape, once out of the field, sends the overlay away with the card still waiting.
  await stageAtRest();
  expect(bridge.requests("inf:overlay:hide")).toEqual([]);
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => bridge.requests("inf:overlay:hide").length).toBe(1);
  expect(bridge.requests("inf:cards:act")).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
