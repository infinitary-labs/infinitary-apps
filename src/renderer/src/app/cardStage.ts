/**
 * The shown card's own paging, close and size, lent by the card layer while
 * it is up (docs/keyboard.md), so a window command pages with the arrows' own
 * slide, puts away through the shared corner and maximizes as
 * the size control does. The layer says which entry it shows, and a command
 * acts only when that is still the entry the store shows: never on another
 * card after a race.
 */
export type CardStage = {
  /** The stack entry on the stage now. */
  shownId: string;
  /** The pager's arrows: 1 is the next card, -1 the previous. */
  page: (dir: 1 | -1) => void;
  /**
   * The presentation-only corner: live decisions wait, notes are read, and window panels hide.
   */
  close: () => void;
  /** The shown entry is maximized (design skill ResponseCard, "Maximize"). */
  maximized: boolean;
  /** Maximizes or restores it, with the keyboard's focus on its size control. */
  toggleSize: () => void;
  /** Every shown card can be put away without ending work. */
  minimize?: () => void;
  /**
   * The thread's own collapse and the cue that opens it: folds the thread
   * into the card's foot, or puts it beside the card again. Absent while
   * the shown entry has no thread to fold.
   */
  thread?: () => void;
};

let lent: (() => CardStage | null) | null = null;

/** The card layer lends its controls while it is mounted; the result takes them back. */
export function lendCardStage(read: () => CardStage | null): () => void {
  lent = read;
  return () => {
    if (lent === read) lent = null;
  };
}

/** The shown card's controls, when a card layer is up and shows one. */
export function cardStage(): CardStage | null {
  return lent?.() ?? null;
}
