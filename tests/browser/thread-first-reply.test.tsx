import type { CardMessage, CardThread } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { inShown } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * A card's thread follows at its foot (INF-3124: "Ideally: it doesn't auto
 * scroll to the latest" only while the captain reads above). The bug this
 * holds: the captain's first reply opens the thread column beside a card
 * whose body fills it, the list follows to its foot, and then the card's
 * choices move under the reply field and shorten the list. The scroll the
 * follow fired was read after that, as if the captain had scrolled up, so
 * the author's acknowledgement stayed below the list and counted as one new
 * line. Data: the decision card a first mate leaves, a first reply of 25
 * lines and a one-line acknowledgement a push later. Completion: the list's
 * own scroll position and the jump down's absence.
 */

const CARD_ID = "fm-thread-card";
const TITLE = "Two ways to phrase the welcome";
const REPLY = [
  "does it cover the caption on a narrow window too?",
  ...Array.from({ length: 24 }, (_, i) => `${i + 1}. a line of the note to reread`),
].join("\n");
const ACK = "I'll check the narrow window and update the card.";

/** A macrotask later: what the core sends next reaches the window in a render of its own. */
const later = () => new Promise<void>((resolve) => setTimeout(resolve));

const list = () => inShown("[data-card-thread] [data-thread-messages]");
const fromFoot = () => {
  const node = list();
  return node.scrollHeight - node.scrollTop - node.clientHeight;
};
const jump = () => document.querySelector("[data-card-thread] [data-thread-jump]");

test("a first reply that opens the thread beside a full card leaves it following to the author's answer", async () => {
  const bridge = fakeBridge(await seededHome({ cardId: CARD_ID, title: TITLE }));
  const messages: CardMessage[] = [];
  const thread = (): CardThread => ({ cardId: CARD_ID, messages: [...messages] });
  const add = (who: CardMessage["who"], text: string) =>
    messages.push({ id: messages.length + 1, cardId: CARD_ID, who, text, at: Date.now() });
  // The core records the captain's reply and answers with the thread; the
  // first mate's acknowledgement comes a push later.
  bridge.answer("inf:cards:reply", (_cardId, reply) => {
    add("captain", typeof reply === "string" ? reply : (reply.text ?? ""));
    void (async () => {
      await later();
      add("firstmate", ACK);
      bridge.push("inf:cards:thread", thread());
    })();
    return thread();
  });
  bridge.answer("inf:cards:seen-update", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();

  const field = inShown("[data-card-reply] textarea");
  await userEvent.click(field);
  await userEvent.fill(field, REPLY);
  await userEvent.click(page.getByRole("button", { name: "Chat", exact: true }));
  await expect
    .poll(() => list().querySelectorAll('[data-thread-message="firstmate"]').length)
    .toBe(1);
  expect(list().scrollHeight > list().clientHeight, "the reply is taller than the thread").toBe(
    true,
  );

  // The captain never scrolled: the acknowledgement shows at the foot, with no jump down.
  await expect.poll(fromFoot).toBeLessThanOrEqual(24);
  expect(jump()).toBeNull();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
