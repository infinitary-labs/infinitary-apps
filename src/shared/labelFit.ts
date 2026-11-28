/**
 * How the label-fit facts sit in an emit_card answer
 * (`src/core/pi/cardFigureFit.ts`): after a blank line, and closing with a
 * fixed sentence. A reader of the receipt (`scripts/dispatch-corpus/cards.ts`)
 * cuts the facts off only when the answer ends with that sentence, so a title
 * that holds the delimiter's words is never read as the facts.
 */
// i18n-exempt: served to the agent, stays English
export const LABEL_FIT_DELIMITER = "\n\nLabel fit:";
// i18n-exempt: served to the agent, stays English
export const LABEL_FIT_END = "then revise the card.";

/** The receipt less its label-fit facts, when it carries them. */
export function withoutLabelFitFacts(text: string): string {
  const at = text.lastIndexOf(LABEL_FIT_DELIMITER);
  return at >= 0 && text.endsWith(LABEL_FIT_END) ? text.slice(0, at) : text;
}
