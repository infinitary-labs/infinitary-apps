import type { LastRound, LastTurn } from "@shared/lastTurn";
import { TAKE_BACK_WINDOW_MS } from "@shared/takeBack";

/**
 * Taking back the newest message on the desktop (docs/composer.md "The last
 * turn" and "Recall and a failed send"; docs/task-capture.md, "Taking back a
 * message"): which round the revert control and Up may name, and until when.
 */

/** A round a take back can name: the core gave its id and when it accepted it. */
export type NamedRound = LastRound & { askId: string; sentAt: number };

/**
 * The newest message, while it may still be taken back: named by a core with
 * the take-back change (an older one gives no `askId` or `sentAt`), not taken
 * back, and inside the minute. The core checks again and refuses past it.
 */
export function revertible(turn: LastTurn | null, now: number): NamedRound | null {
  if (!turn?.askId || turn.sentAt === undefined || turn.takenBack) return null;
  return now - turn.sentAt <= TAKE_BACK_WINDOW_MS ? (turn as NamedRound) : null;
}

/** How long until the newest message leaves the window, in ms; null once it has or never could. */
export function revertibleFor(turn: LastTurn | null, now: number): number | null {
  const round = revertible(turn, now);
  return round ? round.sentAt + TAKE_BACK_WINDOW_MS - now + 1 : null;
}

/** The last turn with the message `askId` marked taken back, wherever it stands. */
export function markedTakenBack(turn: LastTurn | null, askId: string): LastTurn | null {
  if (!turn) return turn;
  if (turn.askId === askId) return { ...turn, takenBack: true };
  if (turn.previous?.askId === askId)
    return { ...turn, previous: { ...turn.previous, takenBack: true } };
  return turn;
}
