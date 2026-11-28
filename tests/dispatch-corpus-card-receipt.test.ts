import { expect, it } from "vitest";
import { cardIdFromEmitResult } from "../scripts/dispatch-corpus/cards.ts";

// emit_card's answer may carry label-fit facts after the card's id
// (src/core/pi/cardFigureFit.ts); replay and corpus export still read the id.
it("reads the card id with and without label-fit facts, and from a title with brackets", () => {
  const facts =
    ' Label fit: SVG text does not wrap. Measured in the card font, 1 of 1 flagged label runs past its box: "Loosen the roots (if root-bound)" ends 70 units past its box\'s right edge (360). Shorten the label.';
  expect(cardIdFromEmitResult("Card shown: Repotting steps (card-fm-1-abc)")).toBe("card-fm-1-abc");
  expect(cardIdFromEmitResult(`Card shown: Repotting steps (card-fm-1-abc)${facts}`)).toBe(
    "card-fm-1-abc",
  );
  expect(cardIdFromEmitResult(`Card shown: Steps (new) (card-fm-2-xyz)${facts}`)).toBe(
    "card-fm-2-xyz",
  );
  expect(cardIdFromEmitResult("Card refused: no")).toBeNull();
});
