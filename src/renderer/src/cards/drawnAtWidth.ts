/**
 * A frame's report that it drew counts only at the width it drew at: the
 * frame's layout width, since a card still growing into place is scaled on
 * screen and its drawing is at its width all the same.
 *
 * The frame's page and the card around it run in two processes, so a report
 * can arrive while the frame is briefly at another width - on Linux a card's
 * first height flashes a scrollbar that narrows the card for a frame or two.
 * The page reports again only when its own reading changes, and a flash it
 * never saw changes nothing, so a report dropped then was never followed by
 * another (INF-669). The newest report waits instead, and counts once the
 * frame is back at its width.
 */
export interface FrameWidth {
  /** The frame's layout width now, or undefined when it has no frame. */
  read(): number | undefined;
  /** Calls `changed` at the next frame and on each size change after; returns the stop. */
  watch(changed: () => void): () => void;
}

/** A width within this many pixels of the frame's is the frame's: the frame rounds a fractional width. */
const WIDTH_SLACK_PX = 1;

export class DrawnAtWidth {
  private waiting: { width: number; drawn: () => void } | null = null;
  private unwatch: (() => void) | null = null;

  constructor(private readonly frame: FrameWidth) {}

  /** The page drew at `width`; `drawn` runs once the frame is at that width, unless a newer report or document comes first. */
  report(width: number, drawn: () => void): void {
    this.waiting = { width, drawn };
    this.settle();
  }

  /** A new document starts over: a report from the one before it never counts. */
  forget(): void {
    this.waiting = null;
    this.unwatch?.();
    this.unwatch = null;
  }

  private settle(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    const actual = this.frame.read();
    if (actual !== undefined && Math.abs(actual - waiting.width) <= WIDTH_SLACK_PX) {
      this.forget();
      waiting.drawn();
      return;
    }
    this.unwatch ??= this.frame.watch(() => this.settle());
  }
}
