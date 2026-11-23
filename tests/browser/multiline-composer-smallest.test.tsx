import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { intersects, type Rect, windowBox, within } from "./layout";
import { messageBox, messageBoxLocator } from "./prompt";
import { answerStack, cardLeave, SHOWN_ENTRY, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * The multi-line composer at the smallest window (fm3000-multiline-input-s1,
 * PR 2; docs/composer.md, "Growth and reflow"): a tall draft leaves the card
 * above it usable - layout asserted as order between measured boxes, never
 * as pixel numbers - and the card still closes with the draft up.
 */

const CARD_ID = "fm-thread-card";
const TITLE = "Two ways to phrase the welcome";
/** The captain's last message, which the card answers. */
const ASK = "keep a firstmate thread open";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function settled<T>(read: () => T): Promise<T> {
  let last: string | undefined;
  let value: T | undefined;
  await expect
    .poll(async () => {
      if (last !== undefined) await nextFrame();
      value = read();
      const json = JSON.stringify(value);
      const same = json === last;
      last = json;
      return same;
    })
    .toBe(true);
  return value as T;
}

function box(selector: string): Rect {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`The window drew no ${selector}`);
  return element.getBoundingClientRect();
}

test("at the smallest window a tall draft stays in view and clear of the card, and the card still closes", async () => {
  const home = subscribed(await seededHome({ cardId: CARD_ID, title: TITLE, ask: ASK }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openSize();
  await openWindow(bridge);
  const title = page.getByRole("region", { name: TITLE, exact: true });
  await expect.element(title).toBeVisible();
  // The card's body has drawn, so the card stands at its full height.
  await expect
    .poll(() =>
      document.querySelector(`${SHOWN_ENTRY} iframe[title="${TITLE} body"][data-frame-drawn]`),
    )
    .not.toBeNull();
  await expect.poll(() => messageBox()?.disabled).toBe(false);
  // The last turn above the input rises with it, as it did when the captain sent the message.
  await expect
    .poll(() => document.querySelector("[data-last-turn] [data-last-turn-bubble]")?.textContent)
    .toContain(ASK);
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);

  const field = messageBox();
  if (!field) throw new Error("The window drew no message box");
  const draft = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  await userEvent.fill(messageBoxLocator(), draft);
  await stageAtRest();
  const laid = await settled(() => ({
    shell: box("[data-voice-input-shell]"),
    card: box("[data-card-layer] [data-card-presentation]"),
    window: windowBox(),
  }));
  expect(within(laid.shell, laid.window)).toEqual([]);
  expect(intersects(laid.shell, laid.card)).toBe(false);

  // With the draft still up, the shared minus puts the card away.
  const layer = document.querySelector<HTMLElement>("[data-card-layer]");
  if (!layer) throw new Error("The window drew no card layer");
  await userEvent.click(cardLeave());
  await expect.element(title).not.toBeInTheDocument();
  expect(bridge.requests("inf:cards:close").map(([id]) => id)).toEqual([CARD_ID]);
  expect(field.value).toBe(draft);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
