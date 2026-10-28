export type ProcessGroupOwner = { owner: string; started: string };

/** Explicit ownership of processes and declared groups; no command-line or folder guessing. */
export class ProcessRoots {
  private readonly roots = new Map<number, string>();
  private readonly groups = new Map<number, ProcessGroupOwner>();

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

  /** A group outlives its leader; a reused leader PID in another group is not this owner. */
  addGroup(group: number, owner: string, started: string): () => void {
    const claim = { owner, started };
    this.groups.set(group, claim);
    return () => {
      if (this.groups.get(group) === claim) this.groups.delete(group);
    };
  }

  readGroups(): ReadonlyMap<number, ProcessGroupOwner> {
    return new Map(this.groups);
  }
}

/** One registry in each app process, shared by its shell jobs and Claude clients. */
export const processRoots = new ProcessRoots();
