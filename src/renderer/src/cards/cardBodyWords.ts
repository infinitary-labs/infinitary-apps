import * as m from "@shared/i18n/messages.generated";

/**
 * What a card's body says when its page cannot be shown whole
 * (`HtmlCardBody`): it stopped responding and was torn down, too many cards
 * with drawings are already open, or it is too large to run its drawings and
 * opens with its words and pictures under that line. A plain module, so the card e2e specs read them from their
 * owner (docs/e2e-contracts.md, "Words come from their owner").
 */
export const CARD_BODY_WORDS = {
  get stopped() {
    return m.cardBodyStopped();
  },
  get failed() {
    return m.cardBodyFailed();
  },
  get drawingsOff() {
    return m.cardBodyDrawingsOff();
  },
};
