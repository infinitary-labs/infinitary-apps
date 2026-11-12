import { CARD_LEAVE } from "@shared/cardLeave";
import * as m from "@shared/i18n/messages.generated";
/**
 * The words the card's size control reads in each state, its accessible name
 * (`CardSize.tsx`), as the tests find the control in English; the control
 * itself calls the messages when it draws, so it follows a language change.
 */
export const MAXIMIZE_LABEL = m.uiCardMaximize();
export const RESTORE_LABEL = m.uiCardRestore();

/**
 * The independent neutral minus that takes a live message off the stack
 * until it changes (INF-770): its name, and the words it shows on rest,
 * which say the comeback.
 */
export const PUT_ASIDE_LABEL = CARD_LEAVE.decision.label;
export const PUT_ASIDE_REST = CARD_LEAVE.decision.restWords;
