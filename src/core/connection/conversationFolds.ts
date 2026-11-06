import { contractChange } from "./contractChanges";

/**
 * A peer that speaks of a held conversation's folds (`conversation-folds.md`):
 * a computer that runs work tells its home each time a conversation there
 * folds its context, and the home sends a crewmate's standing directions
 * again only after such a fold, a change or a new conversation. An older
 * home would refuse the event, so a computer sends it only to a home that
 * lists the change; a home cannot hear an older computer's folds, so it
 * serves that computer's crewmates their directions on every turn.
 */
export const CONVERSATION_FOLDS = contractChange("conversation-folds");
