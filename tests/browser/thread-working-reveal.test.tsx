import type { CardMessage, CardThread } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { inShown } from "./stack";
import { openWindow } from "./window";

/**
 * The thread reveals its working row (INF-1231). The captain: "the
 * 'working' label in the chat panel doesn't show unless i scroll down...
 * it should auto scroll and reveal itself". On the first mate's own card
 * the captain's reply and the first mate's busy flag reach the thread in
 * separate renders, so a thread already past its height must scroll again
 * when `working` appears, not only when the reply does.
 */

const CARD_ID = "fm-thread-card";
const TITLE = "Two ways to phrase the welcome";
const FILL_REPLY = "fill the thread";
const HOLD_REPLY = "take your time on this one";
const LONG_ANSWER =
  "Here is a longer answer so the thread grows past its height. " +
  "It names the caption first, the chips second, and why the order matters to someone reading it cold. " +
  "It keeps going for a few more sentences so each message takes several lines in the thread column. " +
  "That way a handful of replies are enough to push the newest line below the visible area.";

/** A macrotask later: what the core sends next reaches the window in a render of its own. */
const later = () => new Promise<void>((resolve) => setTimeout(resolve));

test("a thread past its height scrolls to show working once the first mate takes a reply", async () => {
  const bridge = fakeBridge(await seededHome({ cardId: CARD_ID, title: TITLE }));
  const messages: CardMessage[] = [];
  const thread = (): CardThread => ({ cardId: CARD_ID, messages: [...messages] });
  const say = (who: CardMessage["who"], text: string) =>
    messages.push({ id: messages.length + 1, cardId: CARD_ID, who, text, at: Date.now() });
  // The core records the captain's reply and answers with the thread; the
  // first mate's turn then starts, its busy flag a push of its own. A reply
  // to fill the thread gets a long answer and the turn ends; a reply to take
  // its time keeps the turn open.
  bridge.answer("inf:cards:reply", (_cardId, reply) => {
    const text = typeof reply === "string" ? reply : (reply.text ?? "");
    say("captain", text);
    void (async () => {
      await later();
      bridge.push("inf:event", { type: "firstmate_state", busy: true });
      if (text.startsWith(HOLD_REPLY)) return;
      await later();
      say("firstmate", LONG_ANSWER);
      bridge.push("inf:cards:thread", thread());
      bridge.push("inf:event", { type: "firstmate_state", busy: false });
    })();
    return thread();
  });
  bridge.answer("inf:cards:seen-update", { ok: true });
  await page.viewport(1280, 800);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();

  const reply = async (text: string) => {
    const field = inShown("[data-card-reply] textarea");
    await userEvent.click(field);
    await userEvent.fill(field, text);
    await userEvent.click(page.getByRole("button", { name: "Chat", exact: true }));
  };
  const list = () => inShown("[data-card-thread] [data-thread-messages]");
  const answered = () => list().querySelectorAll('[data-thread-message="firstmate"]').length;
  const working = () => list().querySelector("[data-thread-working]");
  for (let count = 1; count <= 4; count++) {
    await reply(`${FILL_REPLY} ${count}`);
    await expect.poll(answered).toBe(count);
    await expect.poll(working).toBeNull();
  }
  expect(list().scrollHeight > list().clientHeight, "the thread is past its height").toBe(true);

  await reply(HOLD_REPLY);
  await expect.poll(working).not.toBeNull();
  await expect
    .poll(
      () =>
        (working()?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY) <=
        list().getBoundingClientRect().bottom,
      { message: "the working row sits inside the thread's visible area" },
    )
    .toBe(true);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
