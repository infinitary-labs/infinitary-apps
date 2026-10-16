/**
 * Where a card's thread goes (cards-as-threads phase 1; the captain's C8
 * answer "A beside the card where it fits, C in place below that", with his
 * three tweaks). The arithmetic lives here, away from the DOM, because it
 * is the whole of the behaviour worth pinning - `threadGeometry.test.ts`
 * walks the R3.1 table at 960 / 1200 / 1440 / 1728 with both docks, one
 * dock and none.
 *
 * The ladder has three rungs and is walked in order:
 *
 *  1. **Beside the card**, in ONE container (tweak 1): one surface, one
 *     border, one radius, one shadow, a single hairline between the two
 *     columns, the pair centred on the window as one object.
 *  2. **Fold the docks** (tweak 2). When the pair would leave the card
 *     under `CARD_MIN`, the docked rails give their width back - the stage
 *     becomes the whole window - and the pair is placed again. Collapsed
 *     headers reserve no card clearance. An edge tab says the panels are
 *     one click away.
 *  3. **In place.** The card's body becomes the thread, behind a segmented
 *     control in its head. It needs a stage under 720px, which the app's
 *     own 960px window minimum puts out of reach - it exists because the
 *     ladder must end somewhere, not because the app can get there.
 *
 * Tweak 3 - the reply box under the action row while there is no thread yet
 * - is the card's own footer and needs no arithmetic.
 */

/** The card's design width, the stack's own (`CARD_STACK_WIDTH`). */
export const THREAD_CARD_MAX = 560;
/** The air the stage keeps around the pair, total. */
export const THREAD_STAGE_MARGIN = 32;
/** The thread column: 40% of the stage, held between these. */
export const THREAD_MIN = 288;
export const THREAD_MAX = 360;
/** Below this the card is not a card any more, and the ladder takes its next rung. */
export const CARD_MIN = 400;

/** Where the thread sits, and what the pair measures. */
export type ThreadPlacement = {
  /** `beside` is rungs 1 and 2; `in-place` is rung 3. */
  home: "beside" | "in-place";
  /** The docked rails gave their width back so the pair could fit (rung 2). */
  folded: boolean;
  /** The card column's width in the pair. */
  card: number;
  /** The thread column's width; 0 when the thread is in place. */
  thread: number;
};

/** What the card measures with no thread open: what it asks for, inside the stage's margin. */
export function cardWidth(stage: number, cardMax: number = THREAD_CARD_MAX): number {
  return Math.min(cardMax, stage - THREAD_STAGE_MARGIN);
}

/** The pair inside a given stage, before any folding. */
function pairIn(stage: number, cardMax: number): { card: number; thread: number; fits: boolean } {
  const thread = Math.round(Math.min(THREAD_MAX, Math.max(THREAD_MIN, 0.4 * stage)));
  const card = Math.min(cardMax, stage - THREAD_STAGE_MARGIN - thread);
  return { card, thread, fits: card >= CARD_MIN };
}

/**
 * The ladder, for a window of `windowWidth` with `railsWidth` of docked
 * rails beside the stage. `railsWidth` is the symmetric clearance from
 * twice the larger expanded rail (`--rail-docked-*`), even when folded;
 * a window with no expanded panels passes 0 and can never fold.
 *
 * `cardMax` is the width the card asks for (`requestedCardWidth`): 560 for
 * a regular card, more for a wide or full one or one the captain dragged.
 * The arithmetic is the same with it in place of 560; only the card column
 * grows, and only where the stage has the room.
 */
export function threadPlacement(
  windowWidth: number,
  railsWidth: number,
  cardMax: number = THREAD_CARD_MAX,
): ThreadPlacement {
  const stage = windowWidth - railsWidth;
  const docked = pairIn(stage, cardMax);
  if (docked.fits) {
    return { home: "beside", folded: false, card: docked.card, thread: docked.thread };
  }
  if (railsWidth > 0) {
    const whole = pairIn(windowWidth, cardMax);
    if (whole.fits) {
      return { home: "beside", folded: true, card: whole.card, thread: whole.thread };
    }
    // Even folded it does not fit: the thread goes in place, and the fold
    // stands - the whole window is what the in-place card has to read in,
    // and that is the narrowest rung of all (the prototype's own arithmetic).
    return { home: "in-place", folded: true, card: cardWidth(windowWidth, cardMax), thread: 0 };
  }
  return { home: "in-place", folded: false, card: cardWidth(stage, cardMax), thread: 0 };
}
