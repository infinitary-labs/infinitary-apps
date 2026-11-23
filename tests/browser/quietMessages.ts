import type { Theme } from "@shared/preferences";
import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { messageBox, messageBoxLocator } from "./prompt";
import { openSize, openWindow } from "./window";

/**
 * Intent: the captain's C selection on INF-1968 and the newer upper-round
 * hover bug report (INF-2217): hover and focus light only their own round.
 * Fixture: a conversation of two finished turns, in each look
 * (quiet-messages-dark.test.tsx, quiet-messages-light.test.tsx). Failure: a
 * sibling lighting up, unreadable hovered older type, moving geometry or lost
 * reply reading. The core's turn delivery is the last-turn journey's; the
 * fade while a newer turn works stays in tests/e2e/quiet-messages.spec.ts.
 */

const ROUNDS = [
  { ask: "Keep my earlier clue visible", reply: "Kept. The clue stays where you can see it." },
  {
    ask: "Please keep the conversation easy to read",
    reply: "Done. The older round stays quiet until you look at it.",
  },
];

const ROUND = "[data-last-turn] [data-last-turn-pair]:not([data-leaving])";
const NEWEST = `${ROUND}:not([data-older])`;
const OLDER = `${ROUND}[data-older]`;

function part(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`The window drew no ${selector}`);
  return found;
}

const you = (round = NEWEST) => part(`${round} [data-last-turn-bubble="you"]`);
const mate = (round = NEWEST) => part(`${round} [data-last-turn-bubble="firstmate"]`);
const olderOpacity = () => getComputedStyle(part(OLDER)).opacity;

/** Returns once nothing that moves or recolors `element`, or a box holding it, is still running. */
async function atRest(element: Element): Promise<void> {
  await Promise.all(
    document
      .getAnimations()
      .filter((motion) => {
        const effect = motion.effect;
        return (
          effect instanceof KeyframeEffect &&
          effect.target?.contains(element) === true &&
          effect.getComputedTiming().endTime !== Number.POSITIVE_INFINITY
        );
      })
      .map((motion) => motion.finished.catch(() => undefined)),
  );
}

async function paint(bubble: HTMLElement) {
  await atRest(bubble);
  const style = getComputedStyle(bubble);
  const rect = bubble.getBoundingClientRect();
  return {
    color: style.color,
    background: style.backgroundColor,
    font: style.font,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

async function pointerAway(): Promise<void> {
  await userEvent.hover(messageBoxLocator());
}

function focusMessageBox(): void {
  const box = messageBox();
  if (!box) throw new Error("The window drew no message box");
  box.focus();
  expect(document.activeElement).toBe(box);
}

export async function quietMessagesStory(theme: Theme): Promise<void> {
  const home = await seededHome({ theme, rounds: ROUNDS });
  const bridge = fakeBridge(subscribed(home));
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => document.body.dataset.theme).toBe(theme);
  await expect.poll(() => document.querySelector(OLDER)).not.toBeNull();
  const lane = part("[data-last-turn]");
  const reply = mate();
  const older = mate(OLDER);
  expect(reply.getAttribute("data-state")).toBe("reply");
  const mark = part(`${NEWEST} [data-last-turn-mark]`);
  expect(mark.hasAttribute("data-working")).toBe(false);
  await Promise.all([atRest(you()), atRest(reply), atRest(older), atRest(mark)]);
  const outline = mark.querySelector("polygon");
  if (!outline) throw new Error("The mark drew no outline");
  const markColor = () => getComputedStyle(outline).stroke;

  // At rest: both newest bubbles share one quiet colour, quieter than the
  // lane's own, and the older round is half seen. The page's pointer stays
  // where an earlier file left it, which can be over a round, so the story
  // moves it off every bubble first, as a captain at rest has it.
  await pointerAway();
  focusMessageBox();
  const resting = { you: await paint(you()), reply: await paint(reply) };
  const olderRest = await paint(older);
  const cyan = markColor();
  const primary = getComputedStyle(lane).color;
  expect(resting.you.color).toBe(resting.reply.color);
  expect(resting.reply.color).not.toBe(primary);
  await expect.poll(olderOpacity).toBe("0.5");

  // Section: hovering the reply brightens its round to read, and nothing moves.
  await userEvent.hover(reply);
  const reading = { you: await paint(you()), reply: await paint(reply) };
  expect(reading.reply.color).toBe(primary);
  expect(reading.you.color).toBe(primary);
  expect(reading.you.background).not.toBe(resting.you.background);
  expect(reading.you.box).toEqual(resting.you.box);
  expect(reading.reply.box).toEqual(resting.reply.box);
  expect(reading.reply.font).toBe(resting.reply.font);
  expect(await paint(older)).toEqual(olderRest);
  expect(markColor()).toBe(cyan);

  await userEvent.hover(you());
  expect(await paint(reply)).toEqual(reading.reply);
  expect(await paint(older)).toEqual(olderRest);
  await expect.poll(olderOpacity).toBe("0.5");

  // Section: keyboard focus on the reply reads as hover does.
  await pointerAway();
  reply.focus();
  expect(await paint(reply)).toEqual(reading.reply);
  expect(await paint(older)).toEqual(olderRest);
  await expect.poll(olderOpacity).toBe("0.5");
  expect(markColor()).toBe(cyan);
  focusMessageBox();
  expect(await paint(reply)).toEqual(resting.reply);
  expect(await paint(you())).toEqual(resting.you);

  // Section: INF-2217's live reproduction hit the upper reply but lit the
  // lower one. Each older bubble lights its own round alone.
  for (const target of [older, you(OLDER)]) {
    await userEvent.hover(target);
    expect(await paint(reply)).toEqual(resting.reply);
    expect(await paint(you())).toEqual(resting.you);
    await expect.poll(olderOpacity).toBe("1");
    expect(await paint(older)).toEqual(olderRest);
    expect(markColor()).toBe(cyan);
  }
  await pointerAway();
  older.focus();
  await expect.poll(olderOpacity).toBe("1");
  expect(await paint(reply)).toEqual(resting.reply);
  expect(await paint(you())).toEqual(resting.you);
  await userEvent.tab();
  expect(document.activeElement).toBe(reply);
  expect(await paint(reply)).toEqual(reading.reply);
  await expect.poll(olderOpacity).toBe("0.5");
  focusMessageBox();
  expect(await paint(reply)).toEqual(resting.reply);
  expect(await paint(you())).toEqual(resting.you);

  // Section: each reply opens its whole line, by key and by press, and
  // Escape lets it go.
  const kept = home["inf:conversation:last-turn"];
  if (!kept || typeof kept === "function") throw new Error("The home kept no last turn");
  const words = {
    newest: kept.reply?.words ?? kept.reply?.text,
    older: kept.previous?.reply?.words ?? kept.previous?.reply?.text,
  };
  expect(words.newest && words.older && kept.you, "the home kept both rounds' words").toBeTruthy();
  reply.focus();
  await userEvent.keyboard("{Enter}");
  const note = () => document.querySelector("[data-reply-note]");
  await expect.poll(() => note()?.textContent).toBe(words.newest);
  await userEvent.keyboard("{Escape}");
  await expect.poll(note).toBeNull();
  await userEvent.click(mate(OLDER));
  await expect.poll(() => note()?.textContent).toBe(words.older);
  await userEvent.keyboard("{Escape}");
  await expect.poll(note).toBeNull();

  // Section: the narrowest window keeps the captain's words whole, with no
  // sideways scroll.
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  await expect.element(you()).toBeVisible();
  await expect.poll(() => lane.scrollWidth > lane.clientWidth).toBe(false);
  expect(you().querySelector("[data-last-turn-words]")?.textContent).toBe(kept.you);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
}
