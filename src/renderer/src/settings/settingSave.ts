import * as m from "@shared/i18n/messages.generated";

export type SettingSaveState<T> = {
  value: T | null;
  error: string | null;
  saving: boolean;
};

/** One ordered writer per saved view. A refusal re-reads even after a partial write. */
export class SettingSave<T> {
  state: SettingSaveState<T> = { value: null, error: null, saving: false };
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private revision = 0;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly publish: (state: SettingSaveState<T>) => void,
    private readonly recoveryHint = m.settingsSaveRecoveryHint(),
  ) {}

  private update(change: Partial<SettingSaveState<T>>) {
    this.state = { ...this.state, ...change };
    this.publish(this.state);
  }

  /** Polling must not replace a save or its recovery with an older read. */
  refresh = async (throwOnFailure = false) => {
    if (this.pending) return;
    const revision = ++this.revision;
    try {
      const value = await this.read();
      if (revision === this.revision) {
        this.update({ value, error: this.state.value === null ? null : this.state.error });
      }
    } catch (caught) {
      if (throwOnFailure) throw caught;
      if (revision === this.revision && this.state.value === null) {
        this.update({ error: m.settingsSaveLoadFailed() });
      }
    }
  };

  /**
   * A value the core pushed is the saved value too. Like a poll, it never
   * replaces a save or its recovery, and an older read never replaces it.
   */
  apply = (value: T) => {
    if (this.pending) return;
    ++this.revision;
    this.update({ value, error: this.state.value === null ? null : this.state.error });
  };

  /** Resolves false on refusal: dependent writes (such as selecting a saved key) stop. */
  save = (write: () => Promise<T>): Promise<boolean> => {
    ++this.revision;
    ++this.pending;
    this.update({ saving: true });
    const result = this.tail.then(async () => {
      this.update({ error: null });
      try {
        this.update({ value: await write() });
        return true;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : m.settingsSaveFailed();
        this.update({ error: message });
        try {
          this.update({ value: await this.read() });
        } catch {
          // Do not pretend a failed recovery confirmed the old value.
          this.update({
            error: m.settingsSaveReloadFailed({ message, hint: this.recoveryHint }),
          });
        }
        return false;
      } finally {
        --this.pending;
        this.update({ saving: this.pending > 0 });
      }
    });
    this.tail = result;
    return result;
  };
}
