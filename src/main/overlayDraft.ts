import type { LentDraft } from "@shared/overlayDraft";

/**
 * One main message in two places (docs/card-overlay.md, "The message box"):
 * as the card overlay opens, the window lends its unsent message, and as the
 * overlay goes, the message comes back to the window that lent it. The
 * draft passes through here and is never kept: memory only, as in the
 * window. Electron stays behind `DraftRelayDeps`, so the rules run without a
 * window (./overlayDraft.test.ts).
 */

/** How long the overlay waits for the window's message before it opens with an empty box. */
export const LEND_LIMIT_MS = 300;

export type DraftRelayDeps<Window> = {
  /** The window that lends now - the main window - or null when none is open. */
  lender(): Window | null;
  /** Asks `window` for its message under `ask`; it answers through `lent`. */
  ask(window: Window, ask: number): void;
  /** Gives `window` back the message it lent. */
  handBack(window: Window, lent: LentDraft): void;
  later(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

export class DraftRelay<Window> {
  private asks = 0;
  /** Asks sent and not yet answered, by number. */
  private readonly waiting = new Map<
    number,
    { window: Window; resolve: (lent: LentDraft | null) => void }
  >();
  /** Asks answered, each handed back at most once, to the window that lent it. */
  private readonly lentBy = new Map<number, Window>();

  constructor(private readonly deps: DraftRelayDeps<Window>) {}

  /** The window's message for this opening, or null when no window answers in time. */
  lend(): Promise<LentDraft | null> {
    const window = this.deps.lender();
    if (window === null) return Promise.resolve(null);
    const ask = ++this.asks;
    return new Promise((resolve) => {
      const timer = this.deps.later(() => {
        this.waiting.delete(ask);
        resolve(null);
      }, LEND_LIMIT_MS);
      this.waiting.set(ask, {
        window,
        resolve: (lent) => {
          this.deps.cancel(timer);
          resolve(lent);
        },
      });
      this.deps.ask(window, ask);
    });
  }

  /** `from` answers an ask: taken only from the window asked, and only while the ask waits. */
  lent(from: Window, lent: LentDraft): void {
    const waiting = this.waiting.get(lent.ask);
    if (!waiting || waiting.window !== from) return;
    this.waiting.delete(lent.ask);
    // One overlay opens at a time: an earlier lending whose page never came back is over.
    this.lentBy.clear();
    this.lentBy.set(lent.ask, from);
    waiting.resolve(lent);
  }

  /** The overlay hands a lent message back: once, to the window that lent it. */
  handBack(lent: LentDraft): void {
    const window = this.lentBy.get(lent.ask);
    if (window === undefined) return;
    this.lentBy.delete(lent.ask);
    this.deps.handBack(window, lent);
  }
}
