import * as m from "@shared/i18n/messages.generated";

/**
 * What a card's body says in its page's place when the page cannot be shown
 * (`HtmlCardBody`): it stopped responding and was torn down, or it could not
 * be opened. A plain module, so the card e2e specs read them from their
 * owner (docs/e2e-contracts.md, "Words come from their owner").
 */
export const CARD_BODY_WORDS = {
  get stopped() {
    return m.cardBodyStopped();
  },
  get failed() {
    return m.cardBodyFailed();
  },
};
