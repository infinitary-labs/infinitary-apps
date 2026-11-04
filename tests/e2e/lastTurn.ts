import { expect, type Locator, type Page } from "@playwright/test";
import { atRest } from "./layout";
import { promptInput } from "./prompt";

declare global {
  interface Window {
    /** What `askFirstmate` has heard since it sent its message, in order. */
    __fmAsk?: { heard: string[]; stop: () => void };
  }
}

/**
 * The last turn above the input (`data-last-turn`, painted by `LastTurn`;
 * docs/composer.md "The last turn"): the captain's last two messages, each
 * with the Firstmate's bubble beside it. The older round is marked
 * `data-older`, and the round a newer message pushes out leaves marked
 * `data-leaving`, so `yourBubble` and `mateBubble` read only the newest
 * round. A spec never types the reply's words: they are the mock provider's
 * own, or the line the core kept
 * (`window.infinitary.conversation.lastTurn()`).
 */
const ROUND = "[data-last-turn] [data-last-turn-pair]:not([data-leaving])";
const NEWEST = `${ROUND}:not([data-older])`;
const OLDER = `${ROUND}[data-older]`;

/** The captain's own bubble in the newest round, or the older one's. */
export function yourBubble(page: Page, round: "newest" | "older" = "newest"): Locator {
  return page.locator(`${round === "older" ? OLDER : NEWEST} [data-last-turn-bubble="you"]`);
}

/**
 * The Firstmate's bubble in the newest round, or the older one's;
 * `data-state` says whether it is `working`, a `reply` or a `problem`, and
 * `data-working` marks a reply the Firstmate keeps working after, while its
 * mark (`data-last-turn-mark`) spins.
 */
export function mateBubble(page: Page, round: "newest" | "older" = "newest"): Locator {
  return page.locator(`${round === "older" ? OLDER : NEWEST} [data-last-turn-bubble="firstmate"]`);
}

/** The older round, while it shows. */
export function olderRound(page: Page): Locator {
  return page.locator(OLDER);
}

/** A bubble's whole words, however narrow the bubble draws them. */
export function bubbleWords(bubble: Locator): Locator {
  return bubble.locator("[data-last-turn-words]");
}

/** The opened conversation's shared question bubble, separate from the saved reply words. */
export function replyQuestion(page: Page): Locator {
  return page.locator("[data-reply-note-question] [data-question-bubble]");
}

/** The question's words through their shared bubble owner. */
export function replyQuestionWords(page: Page): Locator {
  return replyQuestion(page).locator("[data-question-bubble-words]");
}

/** INF-2218: select the saved words with the pointer, never by replacing browser selection. */
export async function selectFirstLine(words: Locator): Promise<string> {
  // Center the words before dragging: minimally exposing them at a scroll edge
  // makes Chromium auto-scroll during the gesture and move them away from it.
  await words.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
  );
  await atRest(words);
  const bounds = await words.boundingBox();
  if (!bounds) throw new Error("The words are not drawn");
  const lineHeight = await words.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  const page = words.page();
  await page.mouse.move(bounds.x + 1, bounds.y + lineHeight / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + lineHeight / 2, {
    steps: 8,
  });
  await page.mouse.up();
  return words.evaluate((element) => {
    const selection = element.ownerDocument.getSelection();
    return selection?.anchorNode && element.contains(selection.anchorNode)
      ? selection.toString()
      : "";
  });
}

/**
 * Sends `text` from the main message and waits until the Firstmate has
 * answered it: after the message's own `user_turn`, the core's
 * `firstmate_reply` and then its busy signal down (docs/composer.md, "The
 * last turn"). The witness is that order of typed events, never a glimpse of
 * the character working: a quick turn, even a refused one with its
 * answer-missing retry, can be over before a loaded runner polls again.
 */
export async function askFirstmate(page: Page, text: string, timeout = 30_000): Promise<void> {
  await page.evaluate(() => {
    window.__fmAsk?.stop();
    const heard: string[] = [];
    const stop = window.infinitary.events.on((event) => {
      if (event.type === "user_turn") heard.push("turn");
      else if (event.type === "firstmate_reply") heard.push("reply");
      else if (event.type === "firstmate_state") heard.push(event.busy ? "busy" : "idle");
    });
    window.__fmAsk = { heard, stop };
  });
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await expect
    .poll(
      async () => {
        const heard = await page.evaluate(() => window.__fmAsk?.heard ?? []);
        const turn = heard.lastIndexOf("turn");
        const reply = turn < 0 ? -1 : heard.indexOf("reply", turn);
        return reply >= 0 && heard.indexOf("idle", reply) >= 0 ? "answered" : heard.join(" > ");
      },
      { timeout, message: `the Firstmate answers "${text}"` },
    )
    .toBe("answered");
  await page.evaluate(() => window.__fmAsk?.stop());
}
