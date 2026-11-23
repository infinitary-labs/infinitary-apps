import { isHeldEntry, type StackState, stackOf } from "./stack";

// The last-card fidget: when the captain's own press in this window takes the
// last card off the stage, the first mate plays one fidget
// (FirstmateMachine.stageCleared). A card its author or the app withdraws, one
// closed on another computer, a project focus switch and a view hidden last
// leave the stage still (docs/renderer.md, "The last-card fidget").

/** A card that leaves this long after the captain's press on it still counts as theirs (Keep on a secret card). */
export const PRESS_COUNTS_MS = 15_000;

/** This window's own presses on cards, by card id: when each was pressed. */
const pressedAt = new Map<string, number>();

/** The captain pressed something on these cards in this window: a choice, Done, Got it or Put aside. */
export function noteCardPress(cardIds: readonly string[], now = Date.now()): void {
  for (const [id, at] of pressedAt) if (now - at > PRESS_COUNTS_MS) pressedAt.delete(id);
  for (const id of cardIds) pressedAt.set(id, now);
}

/** This window's presses, for `clearedByPress`. */
export function cardPresses(): ReadonlyMap<string, number> {
  return pressedAt;
}

type StackView = Pick<StackState, "cards" | "heldBackCardIds" | "records">;

/**
 * Whether the stage went from showing cards to empty because of this window's
 * own presses: every card that left was pressed here within `PRESS_COUNTS_MS`
 * and none is only held back by the project focus. A stage holding only views
 * (a task's record, a past card, a panel's card) clears quietly.
 */
export function clearedByPress(
  prev: StackView,
  next: StackView,
  presses: ReadonlyMap<string, number>,
  now: number,
): boolean {
  const before = stackOf(prev);
  if (before.length === 0 || stackOf(next).length > 0) return false;
  const cards = before.filter((entry) => !isHeldEntry(entry));
  return (
    cards.length > 0 &&
    cards.every((card) => {
      const at = presses.get(card.id);
      return (
        at !== undefined && now - at <= PRESS_COUNTS_MS && !next.heldBackCardIds.includes(card.id)
      );
    })
  );
}
