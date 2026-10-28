/** Explicit ownership of processes the app starts; no command-line or folder guessing. */
export class ProcessRoots {
  private readonly roots = new Map<number, string>();

  add(pid: number, owner: string): () => void {
    this.roots.set(pid, owner);
    return () => {
      if (this.roots.get(pid) !== owner) return;
      this.roots.delete(pid);
    };
  }

  read(): ReadonlyMap<number, string> {
    return new Map(this.roots);
  }
}

/** One registry in each app process, shared by its shell jobs and Claude clients. */
export const processRoots = new ProcessRoots();
