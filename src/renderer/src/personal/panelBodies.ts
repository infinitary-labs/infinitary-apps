/**
 * How each of the captain's own panels' bodies fared, by id and version
 * (docs/personal-panels.md, "Placed on the rail"): its module imported and
 * drew, or it would not import, or it threw. A body that has not said so
 * for its current version is still loading. Only the panel on the rail
 * writes here; a draft drawn out of sight never does.
 */
export type PanelBodyState =
  | { version: string; state: "drawn" }
  | { version: string; state: "stopped"; why: string };

let bodies = new Map<string, PanelBodyState>();
const listeners = new Set<() => void>();

export const panelBodies = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Every body's last word, the same map until the next change. */
  list(): ReadonlyMap<string, PanelBodyState> {
    return bodies;
  },
  note(id: string, next: PanelBodyState): void {
    const before = bodies.get(id);
    if (before && JSON.stringify(before) === JSON.stringify(next)) return;
    bodies = new Map(bodies).set(id, next);
    for (const listener of [...listeners]) listener();
  },
};

/** What a thrown body or a failed import said, cut to one line. */
export function stoppedWhy(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.split("\n")[0] ?? text;
}
