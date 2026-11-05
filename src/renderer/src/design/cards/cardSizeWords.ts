import { CARD_LEAVE } from "@shared/cardLeave";
/** The words the card's size control reads in each state, its accessible name (`CardSize.tsx`). */
export const MAXIMIZE_LABEL = "Maximize card";
export const RESTORE_LABEL = "Restore card";

/**
 * The independent neutral minus that takes a live message off the stack
 * until it changes (INF-770): its name, and the words it shows on rest,
 * which say the comeback.
 */
export const PUT_ASIDE_LABEL = CARD_LEAVE.decision.label;
export const PUT_ASIDE_REST = CARD_LEAVE.decision.restWords;
