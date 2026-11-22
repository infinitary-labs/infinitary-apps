import { afterEach, expect, test } from "vitest";
import { bringIntoView } from "../../src/renderer/src/cards/cardFind";

/**
 * Find in this card brings the current match into sight through every
 * scroller holding it (docs/keyboard.md, "Finding in the shown card"): a
 * match an inner scroller hides, inside an inner scroller its outer one
 * hides in turn, ends in sight through both. The card's own layout gives
 * the outer scroller nothing to scroll at the window's smallest size, so the
 * two scrollports are drawn here, at the sizes a card's body and middle take.
 */

afterEach(() => {
  document.body.replaceChildren();
});

function port(scroller: HTMLElement): { top: number; bottom: number } {
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  return { top, bottom: top + scroller.clientHeight };
}

test("a match hidden by an inner and an outer scroller ends in sight through both", () => {
  const outer = document.createElement("div");
  outer.style.cssText = "height:240px;overflow-y:auto";
  const above = document.createElement("div");
  above.style.height = "200px";
  const inner = document.createElement("div");
  inner.style.cssText = "height:320px;overflow-y:auto";
  const lead = document.createElement("div");
  lead.style.height = "900px";
  const match = document.createElement("p");
  match.style.cssText = "margin:0;height:20px";
  match.textContent = "The keyboard journey presses it by keys.";
  const trail = document.createElement("div");
  trail.style.height = "400px";
  const below = document.createElement("div");
  below.style.height = "600px";
  inner.append(lead, match, trail);
  outer.append(above, inner, below);
  document.body.append(outer);

  // At rest the match is out of sight in both: below the inner scroller's
  // port, which itself starts near the outer one's bottom.
  const start = match.getBoundingClientRect();
  expect(start.top).toBeGreaterThan(port(inner).bottom);
  expect(port(inner).top + 60).toBeGreaterThan(port(outer).bottom);

  bringIntoView(match, start.top, start.bottom);

  expect(inner.scrollTop).toBeGreaterThan(0);
  expect(outer.scrollTop).toBeGreaterThan(0);
  const end = match.getBoundingClientRect();
  for (const scroller of [inner, outer]) {
    expect(end.top).toBeGreaterThanOrEqual(port(scroller).top);
    expect(end.bottom).toBeLessThanOrEqual(port(scroller).bottom);
  }
});
