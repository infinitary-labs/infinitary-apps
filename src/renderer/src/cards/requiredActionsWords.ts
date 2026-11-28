import * as m from "@shared/i18n/messages.generated";

/**
 * What leads a merge card's required actions (`AfterMergeStrip.tsx`, and the phone's card), in the source
 * language as the module loads: the phone's generated words and the specs read it, and the window words it
 * when shown (`m.cardRequiredActionsLead`).
 */
export const REQUIRED_ACTIONS_LEAD = m.cardRequiredActionsLead();

/** What leads a card's steps only the captain can do when the card merges nothing, such as a plan (`m.cardCaptainStepsLead`). */
export const CAPTAIN_STEPS_LEAD = m.cardCaptainStepsLead();
