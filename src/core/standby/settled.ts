/**
 * The home's wait before an act it cannot take back (docs/devices.md,
 * "Before an act that cannot be undone"): a merge, a push, a secret use, or
 * telling a computer that runs work what was kept, so it forgets it. Each
 * waits until every computer in reach that keeps a copy holds the record
 * so far, so a computer that takes over finds the act recorded and checks
 * instead of repeating it. With no copies kept it resolves at once.
 */
export class SettledBeforeAct {
  private wait: (() => Promise<void>) | null = null;
  /**
   * Two homes answer with one number (docs/devices.md, "Two homes with one
   * number"): every act waits until the captain keeps one. This home goes on
   * with the act once kept, or stops before it once it steps down.
   */
  private held: { released: Promise<void>; release: () => void } | null = null;

  /** Holds every act from now, or lets them go on. */
  hold(on: boolean): void {
    if (on && !this.held) {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.held = { released, release };
    } else if (!on && this.held) {
      this.held.release();
      this.held = null;
    }
  }

  /** The copies' own wait while they run; null when they stop. */
  follow(wait: (() => Promise<void>) | null): void {
    this.wait = wait;
  }

  /** Resolves once the copies in reach hold every change so far; never rejects. */
  async settled(): Promise<void> {
    while (this.held) await this.held.released;
    const wait = this.wait;
    if (!wait) return;
    try {
      await wait();
    } catch (error) {
      console.warn(`[standby] the copies' wait failed before an act: ${String(error)}`);
    }
  }
}
