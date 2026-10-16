/**
 * Advance orchestration deadlines only after real asynchronous admission work
 * has finished. A session can remain deliberately streaming: track admission,
 * not the model's held prompt. Neither I/O nor the operation's result is mocked.
 */
export class AdmissionClock {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly advanceTimers: (ms: number) => Promise<unknown>) {}

  track<T extends unknown[]>(operation: (...args: T) => Promise<void>) {
    return (...args: T): Promise<void> => {
      const tracked = operation(...args).finally(() => {
        this.pending.delete(tracked);
      });
      this.pending.add(tracked);
      return tracked;
    };
  }

  private async admitted(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async advance(ms: number): Promise<void> {
    await this.admitted();
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      await this.advanceTimers(Math.min(10, ms - elapsed));
      // A timer may admit another turn, including real filesystem reads.
      await this.admitted();
    }
  }

  clear(): void {
    this.pending.clear();
  }
}
