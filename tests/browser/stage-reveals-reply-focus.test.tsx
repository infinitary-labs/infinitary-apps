import { CARD_CHAT_LABEL, type CardMessage, type CardThread } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, inShown, SHOWN_ENTRY, shownEntry } from "./stack";
import { openSize, openWindow } from "./window";

// FI3-722: the reply field keeps the focus through a send, by Enter or by the
// send control, so the captain types the next reply straight away. The keys
// go to whatever holds the focus; nothing clicks the field again.

const CARD_ID = "lone";
const TITLE = "Plot the next leg";
const REPLY = "and the flaky retry - keep it?";

/** The shown card's reply field, read each time: the first reply moves it into the thread. */
const replyField = () => inShown("[data-card-reply] textarea") as HTMLTextAreaElement;

const sent = (text: string) =>
  [...document.querySelectorAll(`${SHOWN_ENTRY} [data-thread-message="captain"]`)].some((message) =>
    message.textContent?.includes(text),
  );

test("after a reply under a lone card, the next reply is typed straight away", async () => {
  const home = subscribed(await seededHome({ cardId: CARD_ID, title: TITLE }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  // The core records each reply and answers with the card's thread.
  const messages: CardMessage[] = [];
  bridge.answer("inf:cards:reply", (cardId, reply): CardThread => {
    const text = typeof reply === "string" ? reply : (reply.text ?? "");
    messages.push({ id: messages.length + 1, cardId, who: "captain", text, at: Date.now() });
    return { cardId, messages: [...messages] };
  });
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();

  const byEnter = `By Enter: ${REPLY}`;
  const bySend = `By the send control: ${REPLY}`;
  await userEvent.click(replyField());
  await userEvent.keyboard(byEnter);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => sent(byEnter)).toBe(true);
  await expect.poll(() => replyField().value).toBe("");
  await expect
    .poll(() => document.activeElement === replyField(), {
      message: "the reply field holds the focus",
    })
    .toBe(true);

  await userEvent.keyboard(bySend);
  await expect.poll(() => replyField().value).toBe(bySend);
  await userEvent.click(
    page
      .elementLocator(shownEntry() as HTMLElement)
      .getByRole("button", { name: CARD_CHAT_LABEL, exact: true }),
  );
  await expect.poll(() => sent(bySend)).toBe(true);
  await expect.poll(() => replyField().value).toBe("");
  await expect
    .poll(() => document.activeElement === replyField(), {
      message: "the reply field holds the focus",
    })
    .toBe(true);

  await userEvent.keyboard("And the tide table?");
  await expect.poll(() => replyField().value).toBe("And the tide table?");
  expect(bridge.requests("inf:cards:reply").map(([cardId]) => cardId)).toEqual([CARD_ID, CARD_ID]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
