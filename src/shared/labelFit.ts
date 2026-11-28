/**
 * Where the label-fit facts begin in an emit_card answer
 * (`src/core/pi/cardFigureFit.ts`). It is a blank line, which a card's title
 * never holds, so a reader of the receipt (`scripts/dispatch-corpus/cards.ts`)
 * cuts the facts off without guessing at the title's own words.
 */
// i18n-exempt: served to the agent, stays English
export const LABEL_FIT_DELIMITER = "\n\nLabel fit:";
