import type { BrowserViewer } from "./browser/browserViews";

/**
 * The windows in programs of their own that say they are in front
 * (docs/phone-push.md, "When the computer sends"): the window opened beside a
 * first mate a command started, and each view on another Mac. Each says so
 * on its own connection when it comes to the front and when it leaves it;
 * the latest word of each is kept until its connection drops, so a window
 * closed or ended while in front never holds the phone quiet.
 */
export class WindowsInFront {
  private readonly front = new Set<BrowserViewer>();
  private readonly heard = new WeakSet<BrowserViewer>();

  /** One window's latest word, on the connection that said it. */
  report(window: BrowserViewer, inFront: boolean): void {
    if (!this.heard.has(window)) {
      this.heard.add(window);
      window.onGone(() => this.front.delete(window));
    }
    if (inFront) this.front.add(window);
    else this.front.delete(window);
  }

  /** Whether any window still connected last said it is in front. */
  any(): boolean {
    return this.front.size > 0;
  }
}
