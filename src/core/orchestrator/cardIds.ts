/**
 * Card ids and who minted them, kept apart from the card emitter so a
 * reader of saved cards can tell them apart without loading it.
 */

/** Firstmate-agent cards are id-prefixed so `CardActions.act` can route their answers. */
export const FIRSTMATE_CARD_PREFIX = "card-fm-";

/**
 * Who put a task's card on the stack, read off its id: the Firstmate mints
 * `card-fm-…`, a crewmate `card-<taskId>-…`; anything else (the auth cards)
 * is the host's own.
 */
export function cardEmitter(cardId: string, taskId: string): "firstmate" | "crewmate" | "host" {
  if (cardId.startsWith(FIRSTMATE_CARD_PREFIX)) return "firstmate";
  if (cardId.startsWith(`card-${taskId}-`)) return "crewmate";
  return "host";
}
