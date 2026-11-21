import { z } from "zod";

/**
 * How much of the stage a card asks for (the captain's Q5 to Q7 A of
 * 2026-09-28; docs/card-authoring.md "Card width"): `regular` is the 560 px
 * card every card was until then, `wide` 800 px, `full` the stage up to
 * 1,040 px. The host decides it at emit from closed facts about the body -
 * a wide table, a long code line, a large picture, a picture group, a
 * preview - and the author's `width` hint can only widen it. The captain's
 * drag is the shell's alone and never reaches the row.
 */
export const CARD_WIDTHS = ["regular", "wide", "full"] as const;
export const cardWidthSchema = z.enum(CARD_WIDTHS);
export type CardWidth = z.infer<typeof cardWidthSchema>;

/** The wider of two widths: the order every widening rule reads. */
export function widerCardWidth(a: CardWidth, b: CardWidth | undefined): CardWidth {
  if (!b) return a;
  return CARD_WIDTHS.indexOf(b) > CARD_WIDTHS.indexOf(a) ? b : a;
}
