import type { PanelMount, PanelMountKind, PanelMounts } from "@shared/personal/mounts";

/**
 * The window's newest answer about its panels (docs/personal-panels.md,
 * "Placed on the rail"): which it drew, which it refused, and why. The
 * window sends it whenever it changes (`inf:plugins:personal:mounts`); a
 * crewmate's `place_panel` waits on it and the Firstmate's surfaces list
 * reads it. Null until a window has answered, which every reader says as
 * "no word from the window", never as drawn. A plain module, so an e2e
 * spec reads `mountLine`'s words from their owner (docs/e2e-contracts.md).
 */
export class PanelMountsHolder {
  private latest: PanelMounts | null = null;
  private readonly waiters = new Set<() => void>();

  /** The window's newest answer; the dispatcher's handler is its one writer. */
  note(mounts: PanelMounts): void {
    this.latest = mounts;
    for (const wake of [...this.waiters]) wake();
  }

  current(): PanelMounts | null {
    return this.latest;
  }

  /** One panel as the window last answered, or undefined when it did not name it. */
  of(id: string, kind: PanelMountKind): PanelMount | undefined {
    return this.latest ? mountOf(this.latest, id, kind) : undefined;
  }

  /**
   * The first answer `settled` accepts, now or when the window sends one,
   * or null once `timeoutMs` passes without one. The wait is the window's
   * time to import and draw a module, a physical limit, never a judgment.
   */
  until(settled: (mounts: PanelMounts) => boolean, timeoutMs: number): Promise<PanelMounts | null> {
    if (this.latest && settled(this.latest)) return Promise.resolve(this.latest);
    return new Promise((resolve) => {
      const done = (answer: PanelMounts | null) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(answer);
      };
      const wake = () => {
        if (this.latest && settled(this.latest)) done(this.latest);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      this.waiters.add(wake);
    });
  }
}

/** One panel of one kind in an answer: the app's own panel and the captain's may share an id. */
export function mountOf(
  mounts: PanelMounts,
  id: string,
  kind: PanelMountKind,
): PanelMount | undefined {
  return mounts.panels.find((panel) => panel.id === id && panel.kind === kind);
}

/** One panel as the window answered for it, in a crewmate's words. */
export function mountLine(mount: PanelMount): string {
  const rail = mount.rail ? `the ${mount.rail} rail` : "no rail";
  const why = mount.why ? `: ${mount.why}` : "";
  switch (mount.state) {
    case "drawn":
      return `drawn on ${rail}`;
    case "collapsed":
      return `on ${rail}, folded to its header (the captain collapsed it), so its body is out of sight`;
    case "loading":
      return `on ${rail}, its module still loading`;
    case "stopped":
      return `on ${rail}, but its body stopped drawing${why}`;
    case "off":
      return `registered, but nothing of it is on ${rail}${why}`;
    case "hidden":
      return "kept off the rails: the captain's layout hides it";
    case "refused":
      return `refused${why}`;
  }
}
