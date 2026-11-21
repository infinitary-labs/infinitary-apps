import * as m from "@shared/i18n/messages.generated";
import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { CARD_DRAG_MIN } from "../../src/renderer/src/cards/cardGeometry";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { intersects, type Rect } from "./layout";
import { inShown, stageAtRest } from "./stack";
import { APP_WINDOW, openWindow } from "./window";

/**
 * A narrow card's head keeps its parts whole and apart (the captain's
 * report: in a small window a review card's model chip broke its name
 * letter by letter and was drawn over the task's key; design skill
 * `components/cards/ResponseCard.prompt.md`, the model chip). At the
 * window's usual size the head stays one row.
 */

const TITLE = "Review the stop-older-copy change";
const CARD = "Review of the update change: three choices on stopping an older copy at an update";
const MODEL = "Claude Opus 5.5";

const box = (element: Element): Rect => element.getBoundingClientRect();
const middle = (rect: Rect) => rect.y + rect.height / 2;

/** The shown card's head chip reading `words`: the outermost part of the head that reads only them. */
function headChip(words: string): Element {
  const chip = [...inShown("[data-card-head]").querySelectorAll("*")].find(
    (part) => part.textContent === words && part.parentElement?.textContent !== words,
  );
  if (!chip) throw new Error(`The shown card's head drew no chip reading ${words}`);
  return chip;
}

/** The shown card's head parts: its chips, the key, the meta words, the model chip and each corner button. */
function headParts(): Record<string, Element> {
  const corner = [...inShown("[data-card-corner]").querySelectorAll("button")];
  return {
    kind: headChip(m.uiCardKindDecision()),
    finding: headChip(m.cardReviewFinding()),
    key: inShown("[data-card-key]"),
    meta: inShown("[data-card-meta]"),
    model: inShown("[data-model-chip]"),
    ...Object.fromEntries(corner.map((button) => [button.getAttribute("aria-label"), button])),
  };
}

/**
 * Returns once the head's look has settled: every face the page asked for
 * has loaded and the stage has drawn it at rest. A part measured while its
 * face is still loading is measured in the computer's fallback, whose width
 * differs from the face the window draws in: on Linux the default mono face
 * sets the model chip's name narrower than the code font does.
 */
async function headSettled(): Promise<void> {
  await document.fonts.ready;
  await stageAtRest();
}

/** Each pair of head parts drawn over each other. */
function overlaps(): string[] {
  const parts = Object.entries(headParts());
  return parts.flatMap(([name, part], at) =>
    parts
      .slice(at + 1)
      .filter(([, other]) => intersects(box(part), box(other)))
      .map(([other]) => `${name} over ${other}`),
  );
}

test("a narrow card keeps its head's model chip whole and clear of the key and buttons", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, card: CARD, model: MODEL }));
  // The core records that the captain saw the card, as it does.
  bridge.answer("inf:cards:seen-update", { ok: true });
  await page.viewport(APP_WINDOW.width, APP_WINDOW.height);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: CARD, exact: true })).toBeVisible();
  await headSettled();

  // At the usual size the chips, the key, the model chip and the corner share one row.
  const whole = box(inShown("[data-model-chip]"));
  const row = middle(whole);
  for (const [name, part] of Object.entries(headParts())) {
    const off = Math.abs(middle(box(part)) - row);
    expect(off, `${name} sits on the head's one row`).toBeLessThanOrEqual(1);
  }
  expect(overlaps()).toEqual([]);

  // In the smallest window, with the card at its narrowest.
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  const edge = document.querySelector<HTMLElement>('[data-card-layer] [data-card-edge="right"]');
  if (!edge) throw new Error("The shown card drew no right edge");
  edge.focus();
  await userEvent.keyboard("{Home}");
  const layer = document.querySelector("[data-card-layer]") as Element;
  await expect.poll(() => box(layer).width).toBeCloseTo(CARD_DRAG_MIN, 0);
  await headSettled();

  const narrow = box(inShown("[data-model-chip]"));
  expect(narrow.width, "the model chip keeps its whole name").toBeCloseTo(whole.width, 0);
  expect(narrow.height, "the model chip keeps its name on one line").toBeCloseTo(whole.height, 0);
  await expect.element(inShown("[data-model-chip]")).toBeInViewport({ ratio: 1 });
  expect(overlaps()).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
