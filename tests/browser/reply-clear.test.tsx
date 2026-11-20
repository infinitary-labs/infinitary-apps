import type { CardMessage, CardThread } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { messageBox } from "./prompt";
import { inShown, SHOWN_ENTRY } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * A sent message leaves its box at once: a card's reply box is already
 * empty when the reply paints in the thread, and the main message box
 * clears in the first render of its send. One window, as the captain keeps
 * one: the card's replies come first, then the main box.
 */

const CARD_ID = "thread-card";
const TITLE = "Two ways to fix the flaky test";
const PROSE_REPLY = "and the flaky retry - keep it?";
const PROSE_ANSWER = "Kept it; the queue flush makes the retry harmless either way.";

/**
 * Sends `text` from the shown card's reply box by Enter and reads the box
 * at the moment the reply first paints in the thread: a MutationObserver
 * callback runs in the same task as the commit that drew it, so the order
 * is exact - no clock.
 */
async function boxWhenReplyPaints(text: string): Promise<string | null> {
  const box = () => inShown("[data-card-reply] textarea") as HTMLTextAreaElement;
  await userEvent.click(box());
  await userEvent.fill(box(), text);
  expect(box().value).toBe(text);
  let seen: string | null | undefined;
  const observer = new MutationObserver(() => {
    const painted = [...document.querySelectorAll('[data-thread-message="captain"]')].some((el) =>
      el.textContent?.includes(text),
    );
    if (!painted || seen !== undefined) return;
    seen =
      document.querySelector<HTMLTextAreaElement>(`${SHOWN_ENTRY} [data-card-reply] textarea`)
        ?.value ?? null;
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => seen).not.toBeUndefined();
  await expect.poll(() => box().value).toBe("");
  return seen ?? null;
}

test("a sent message leaves its box at once, in a card's reply box and in the main message box", async () => {
  const bridge = fakeBridge(subscribed(await seededHome({ cardId: CARD_ID, title: TITLE })));
  const messages: CardMessage[] = [];
  const thread = (): CardThread => ({ cardId: CARD_ID, messages: [...messages] });
  const say = (who: CardMessage["who"], text: string) =>
    messages.push({ id: messages.length + 1, cardId: CARD_ID, who, text, at: Date.now() });
  // The core records the reply and answers with the thread; the crewmate
  // answers the first reply in the thread a moment later.
  bridge.answer("inf:cards:reply", (_cardId, reply) => {
    const text = typeof reply === "string" ? reply : (reply.text ?? "");
    say("captain", text);
    if (text === PROSE_REPLY)
      setTimeout(() => {
        say("crewmate", PROSE_ANSWER);
        bridge.push("inf:cards:thread", thread());
      });
    return thread();
  });
  bridge.answer("inf:cards:seen-update", { ok: true });
  bridge.answer("inf:converse", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();

  // The card's reply box is already empty when the sent reply paints in the thread.
  const seen: (string | null)[] = [];
  seen.push(await boxWhenReplyPaints(PROSE_REPLY));
  await expect.poll(() => inShown("[data-card-thread]").textContent).toContain(PROSE_ANSWER);
  for (let i = 0; i < 4; i++) seen.push(await boxWhenReplyPaints(`thread panel reply ${i + 1}`));
  expect(seen, "the box's value when each reply painted in the thread").toEqual([
    "",
    "",
    "",
    "",
    "",
  ]);

  // The main message box clears in the first render of its send.
  const field = messageBox();
  if (!field) throw new Error("The window drew no message box");
  await userEvent.fill(field, "main composer immediate clear");
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  // React batches the event: read its first commit, not inside keydown.
  await Promise.resolve();
  expect(field.value).toBe("");
  await expect
    .poll(() => bridge.requests("inf:converse").map(([turn]) => JSON.stringify(turn)))
    .toEqual([expect.stringContaining("main composer immediate clear")]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
