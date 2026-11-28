import { holdsWords, type LentDraft, type MainDraft } from "@shared/overlayDraft";

/**
 * One main message in two places (docs/card-overlay.md, "The message box"):
 * as the card overlay opens, the window lends its unsent message, and as the
 * overlay goes, the message comes back to the window that lent it. Words no
 * window lent for - none was open, or it answered too late - are kept here
 * for the next overlay opening or for a window whose box is empty (the
 * captain's choice on INF-7228's review). Memory only, as in the window.
 * Electron stays behind `DraftRelayDeps`, so the rules run without a window
 * (./overlayDraft.test.ts).
 */

/** How long the overlay waits for the window's message before it opens with what is kept, or an empty box. */
export const LEND_LIMIT_MS = 300;

export type DraftRelayDeps<Window> = {
  /** The window that lends now - the main window - or null when none is open. */
  lender(): Window | null;
  /** Asks `window` for its message under `ask`; it answers through `lent`. */
  ask(window: Window, ask: number): void;
  /** Gives `window` back the message it lent. */
  handBack(window: Window, lent: LentDraft): void;
  /** Tells every open window that words are kept for an empty box; one takes them through `takeKept`. */
  kept(): void;
  later(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

const EMPTY: MainDraft = { text: "", pastes: [], attachments: [], lastSent: null, replacing: null };

export class DraftRelay<Window> {
  private asks = 0;
  /** Asks sent and not yet answered, by number. */
  private readonly waiting = new Map<
    number,
    { window: Window; resolve: (lent: LentDraft) => void }
  >();
  /** Openings given a message and not yet handed back, each with the window that lent it, or null. */
  private readonly open = new Map<number, Window | null>();
  /** Words handed back with no window to take them. */
  private keptDraft: MainDraft | null = null;
  /**
   * The opening the kept words went to. They stay kept until it hands back,
   * since a page whose first reads fail, or that goes while starting, never
   * does; the next opening gets them again.
   */
  private keptFor: number | null = null;

  constructor(private readonly deps: DraftRelayDeps<Window>) {}

  /** The message for this opening: the window's, else what is kept, else an empty one. */
  lend(): Promise<LentDraft> {
    const ask = ++this.asks;
    // One overlay opens at a time: an earlier opening whose page never came back is over.
    this.open.clear();
    this.keptFor = null;
    const window = this.deps.lender();
    if (window === null)
      return Promise.resolve(this.opened(ask, null, this.offerKept(ask) ?? EMPTY));
    return new Promise((resolve) => {
      const timer = this.deps.later(() => {
        this.waiting.delete(ask);
        resolve(this.opened(ask, null, this.offerKept(ask) ?? EMPTY));
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
    // An empty box opens with the kept words, and the window's recall when they have none;
    // handed back, they reach this window.
    const kept = holdsWords(lent.draft) ? null : this.offerKept(lent.ask);
    const draft = kept ? { ...kept, lastSent: kept.lastSent ?? lent.draft.lastSent } : lent.draft;
    waiting.resolve(this.opened(lent.ask, from, draft));
  }

  /**
   * The overlay hands its message back, once per opening: to the window that
   * lent it, or, when none did, kept while it holds words.
   */
  handBack(lent: LentDraft): void {
    if (!this.open.has(lent.ask)) return;
    const window = this.open.get(lent.ask) ?? null;
    this.open.delete(lent.ask);
    if (this.keptFor === lent.ask) {
      this.keptDraft = null;
      this.keptFor = null;
    }
    if (window !== null) {
      this.deps.handBack(window, lent);
      return;
    }
    if (!holdsWords(lent.draft)) return;
    this.keptDraft = lent.draft;
    this.deps.kept();
  }

  /** The kept words, given once to a window with an empty box; none while an opening holds them. */
  takeKept(): MainDraft | null {
    if (this.keptFor !== null) return null;
    const kept = this.keptDraft;
    this.keptDraft = null;
    return kept;
  }

  /** The kept words for this opening, still kept until it hands back. */
  private offerKept(ask: number): MainDraft | null {
    if (this.keptDraft === null) return null;
    this.keptFor = ask;
    return this.keptDraft;
  }

  private opened(ask: number, window: Window | null, draft: MainDraft): LentDraft {
    this.open.set(ask, window);
    return { ask, draft };
  }
}
