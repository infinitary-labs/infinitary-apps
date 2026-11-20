/**
 * Who has the copy's files open on the computer that keeps it (docs/devices.md,
 * "On the computer that keeps it"): the keeper writes the copy, renames a full
 * copy into place and removes what a change took away, while another copy
 * about to take over reads its files over the link between copies
 * (`StandbyPeers`). Windows refuses to rename or remove a file or folder that
 * another reader holds open, so the two never overlap: a write waits until
 * every read under way has closed its file, and a read waits while a write
 * runs. Reads go on side by side.
 */
export class CopyAccess {
  private readers = 0;
  private writing: Promise<void> | null = null;
  private readonly idle: (() => void)[] = [];

  /** Runs `work`, which opens and closes the copy's files, while no write runs. */
  async read<T>(work: () => Promise<T>): Promise<T> {
    while (this.writing) await this.writing;
    this.readers += 1;
    try {
      return await work();
    } finally {
      this.readers -= 1;
      if (this.readers === 0) for (const wake of this.idle.splice(0)) wake();
    }
  }

  /** Runs `work` once every read under way closed its files, holding new reads until it ends. */
  async write<T>(work: () => Promise<T>): Promise<T> {
    while (this.writing) await this.writing;
    let release: () => void = () => {};
    this.writing = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      while (this.readers > 0) await new Promise<void>((resolve) => this.idle.push(resolve));
      return await work();
    } finally {
      this.writing = null;
      release();
    }
  }
}
