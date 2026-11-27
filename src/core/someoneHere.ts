import type { BrowserViewer } from "./browser/browserViews";

/** What one window in a program of its own last said (`inf:window:front`, `inf:window:someone-here`). */
type Word = { front?: boolean; here?: boolean };

/**
 * Whether someone is at a computer that shows this first mate
 * (docs/phone-push.md, "When the computer sends"): a window in a program of
 * its own says so on its own connection, the first mate's own program says
 * so where it runs a window, and a window from before the change says only
 * that it is in front, which counts while it says it. Each connection's word
 * is kept until it drops, so a window closed or ended never holds the phone.
 */
export class SomeoneHere {
  private readonly words = new Map<BrowserViewer, Word>();
  private readonly heard = new WeakSet<BrowserViewer>();
  /** The reading of this program's own windows; undefined where it runs none (`own`). */
  private ownWord: boolean | undefined;
  private was = false;
  private readonly leaving = new Set<() => void>();

  /** An older window's `inf:window:front`. */
  front(window: BrowserViewer, inFront: boolean): void {
    this.say(window, { front: inFront });
  }

  /** A window's `inf:window:someone-here`, which outranks its front from then on. */
  here(window: BrowserViewer, here: boolean): void {
    this.say(window, { here });
  }

  /** The first mate's own program read its computer (src/main/attendance.ts). */
  own(here: boolean): void {
    this.ownWord = here;
    this.changed();
  }

  /** Whether this program's own windows say anything, which only a program with a window does. */
  readsOwn(): boolean {
    return this.ownWord !== undefined;
  }

  any(): boolean {
    if (this.ownWord) return true;
    for (const word of this.words.values()) if (word.here ?? word.front) return true;
    return false;
  }

  /** Runs `listener` each time the last word that someone is there ends. */
  onLeft(listener: () => void): () => void {
    this.leaving.add(listener);
    return () => this.leaving.delete(listener);
  }

  private say(window: BrowserViewer, word: Word): void {
    if (!this.heard.has(window)) {
      this.heard.add(window);
      window.onGone(() => {
        this.words.delete(window);
        this.changed();
      });
    }
    this.words.set(window, { ...this.words.get(window), ...word });
    this.changed();
  }

  private changed(): void {
    const now = this.any();
    const left = this.was && !now;
    this.was = now;
    if (left) for (const listener of [...this.leaving]) listener();
  }
}
