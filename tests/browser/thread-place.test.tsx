import type { CardMessage, CardThread } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { threadJumpWords } from "../../src/renderer/src/cards/threadWords";
import { type FakeBridge, fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { inShown } from "./stack";
import { openWindow } from "./window";

/**
 * A card's thread keeps the captain's place (INF-3124, direction B). The
 * captain: "interacting with a thread on a card: currently, it auto scroll
 * down to the latest message update at the bottom. That disrupts my flow...
 * Ideally: it doesn't auto scroll to the latest. Optional: there is a UI
 * floating component indicating there are new messages." Read above the
 * foot, nothing but the captain moves the list, and the jump down counts
 * what arrives below; at the foot it follows, opening a reply taller than
 * the list at its first line.
 */

const CARD_ID = "fm-thread-card";
const TITLE = "Two ways to phrase the welcome";
const ANSWER =
  "Here is a longer answer so the thread grows past its height. " +
  "It names the caption first, the chips second, and why the order matters to someone reading it cold. " +
  "It keeps going for a few more sentences so each message takes several lines in the thread column.";
/** An answer far taller than the thread column. */
const TALL_ANSWER = Array.from({ length: 12 }, () => ANSWER).join("\n\n");

/** A macrotask later: what the core sends next reaches the window in a render of its own. */
const later = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The first mate's card with a thread past its height, at its foot. */
async function filledThread(): Promise<{
  bridge: FakeBridge;
  say: (who: CardMessage["who"], text: string) => Promise<void>;
  busy: (busy: boolean) => Promise<void>;
}> {
  const bridge = fakeBridge(await seededHome({ cardId: CARD_ID, title: TITLE }));
  const messages: CardMessage[] = [];
  const thread = (): CardThread => ({ cardId: CARD_ID, messages: [...messages] });
  const add = (who: CardMessage["who"], text: string) =>
    messages.push({ id: messages.length + 1, cardId: CARD_ID, who, text, at: Date.now() });
  // The core records the captain's reply and answers with the thread; the
  // first mate's answer comes a push later.
  bridge.answer("inf:cards:reply", (_cardId, reply) => {
    add("captain", typeof reply === "string" ? reply : (reply.text ?? ""));
    void (async () => {
      await later();
      add("firstmate", ANSWER);
      bridge.push("inf:cards:thread", thread());
    })();
    return thread();
  });
  bridge.answer("inf:cards:seen-update", { ok: true });
  await page.viewport(1280, 800);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  for (let count = 1; count <= 4; count++) {
    const field = inShown("[data-card-reply] textarea");
    await userEvent.click(field);
    await userEvent.fill(field, `fill the thread ${count}`);
    await userEvent.click(page.getByRole("button", { name: "Chat", exact: true }));
    await expect
      .poll(() => list().querySelectorAll('[data-thread-message="firstmate"]').length)
      .toBe(count);
  }
  expect(list().scrollHeight > list().clientHeight, "the thread is past its height").toBe(true);
  await expect.poll(atFoot).toBe(true);
  return {
    bridge,
    say: async (who, text) => {
      add(who, text);
      bridge.push("inf:cards:thread", thread());
      await later();
    },
    busy: async (busy) => {
      bridge.push("inf:event", { type: "firstmate_state", busy });
      await later();
    },
  };
}

const list = () => inShown("[data-card-thread] [data-thread-messages]");
const atFoot = () => {
  const node = list();
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
};
const jump = () =>
  document.querySelector<HTMLButtonElement>("[data-card-thread] [data-thread-jump]");
/** Where a message's top shows against the list's top, in pixels, once its entrance has settled. */
const topInList = async (id: number) => {
  const line = list().querySelector(`[data-thread-message-id="${id}"]`);
  if (!line) return Number.NaN;
  await Promise.all(line.getAnimations().map((animation) => animation.finished));
  return line.getBoundingClientRect().top - list().getBoundingClientRect().top;
};

test("a thread holds the place read above, counts what arrives below, and follows at its foot", async () => {
  const { bridge, say, busy } = await filledThread();
  // The captain scrolls back to the start: the jump down shows its plain arrow.
  list().scrollTop = 0;
  await expect.poll(() => jump()?.textContent).toBe(threadJumpWords(0));

  // The author's turn starting and ending moves nothing, and counts nothing.
  await busy(true);
  await expect.poll(() => list().querySelector("[data-thread-working]")).not.toBeNull();
  expect(list().scrollTop).toBe(0);
  await busy(false);
  expect(list().scrollTop).toBe(0);
  expect(jump()?.textContent).toBe(threadJumpWords(0));

  // The first mate's line and the app's arrive below: the list stays, and they are counted.
  await say("firstmate", "One more thing about the chips.");
  await expect.poll(() => jump()?.textContent).toBe(threadJumpWords(1));
  await say("host", "revised: Two ways to phrase the welcome");
  await expect.poll(() => jump()?.textContent).toBe(threadJumpWords(2));
  expect(list().scrollTop).toBe(0);

  // Enter on it goes to the first new line - here the foot, since both fit - and leaves the keyboard in the list.
  const firstNew = 9;
  jump()?.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(atFoot).toBe(true);
  expect(await topInList(firstNew)).toBeGreaterThanOrEqual(0);
  expect(document.activeElement).toBe(list());

  // A pointer press goes there too, and leaves no keyboard ring on the list.
  list().scrollTop = 0;
  await expect.poll(() => jump()?.textContent).toBe(threadJumpWords(0));
  await userEvent.click(page.elementLocator(jump() as HTMLButtonElement));
  await expect.poll(atFoot).toBe(true);
  expect(list().matches(":focus-visible"), "a pointer press rings the list").toBe(false);

  // Back at the start, the command by name goes to the foot, where the jump leaves.
  list().scrollTop = 0;
  await expect.poll(() => jump()?.textContent).toBe(threadJumpWords(0));
  bridge.push("inf:keyboard:command", { command: "cards.thread-new" });
  await expect.poll(atFoot).toBe(true);
  await expect.poll(jump).toBeNull();

  // The captain's own reply, sent from above, takes the list to its foot.
  list().scrollTop = 0;
  await expect.poll(jump).not.toBeNull();
  const field = inShown("[data-card-reply] textarea");
  await userEvent.click(field);
  await userEvent.fill(field, "and the caption?");
  await userEvent.click(page.getByRole("button", { name: "Chat", exact: true }));
  await expect.poll(atFoot).toBe(true);
  await expect.poll(jump).toBeNull();

  // At its foot the thread follows the author's turn and a short line.
  await expect
    .poll(() => list().querySelectorAll('[data-thread-message="firstmate"]').length)
    .toBe(6);
  await busy(true);
  await expect.poll(() => list().querySelector("[data-thread-working]")).not.toBeNull();
  await expect.poll(atFoot).toBe(true);
  await say("firstmate", "A short line.");
  await expect.poll(atFoot).toBe(true);
  expect(jump()).toBeNull();

  // A reply taller than the list opens with its first line at the top, and holds there.
  const tall = 14;
  await say("firstmate", TALL_ANSWER);
  await expect.poll(async () => Math.abs((await topInList(tall)) - 4) <= 2).toBe(true);
  const held = list().scrollTop;
  await busy(false);
  expect(list().scrollTop).toBe(held);
  await expect.poll(() => jump()?.textContent).toBe(threadJumpWords(0));
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
