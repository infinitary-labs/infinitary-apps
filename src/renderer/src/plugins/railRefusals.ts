import type { PanelMountKind } from "@shared/personal/mounts";

/**
 * The panels the window would not mount, each with the refusal's own words
 * (docs/personal-panels.md, "Placed on the rail"): a real error at
 * registration, such as a panel of the captain's named after one of the
 * app's, whose id the app's own panel already holds. The one place a
 * refusal is kept, so the window's answer about its panels
 * (./panelMounts.ts) can say why one is missing instead of a console line
 * no one reads. Kept by kind as well as id, since the refused panel and the
 * one holding its id share the id. A panel that mounts, or leaves, is no
 * longer refused.
 */
export type RailRefusal = { kind: PanelMountKind; id: string; why: string };

let refused = new Map<string, RailRefusal>();
const listeners = new Set<() => void>();

function publish(next: Map<string, RailRefusal>): void {
  refused = next;
  for (const listener of [...listeners]) listener();
}

/** The key a refusal is kept under: its kind and its id. */
export function refusalKey(kind: PanelMountKind, id: string): string {
  return `${kind}:${id}`;
}

export const railRefusals = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Every refused panel by `refusalKey`, the same map until the next change. */
  list(): ReadonlyMap<string, RailRefusal> {
    return refused;
  },
  /** The window would not mount this panel, for this reason. */
  refuse(kind: PanelMountKind, id: string, why: string): void {
    const key = refusalKey(kind, id);
    if (refused.get(key)?.why === why) return;
    publish(new Map(refused).set(key, { kind, id, why }));
  },
  /** It mounted, or it left: nothing refused it any more. */
  clear(kind: PanelMountKind, id: string): void {
    const key = refusalKey(kind, id);
    if (!refused.has(key)) return;
    const next = new Map(refused);
    next.delete(key);
    publish(next);
  },
};

/** A refusal's words without the error's class name: what it says, not what threw it. */
export function refusalWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
