import type { RailSide } from "@shared/plugins/manifest";
import { useSyncExternalStore } from "react";
import type { RailRoom } from "./railRoom";

/**
 * What each rail's room ladder did with its panels (docs/ui-plugins.md,
 * "When a rail runs out of room"), as `Rail.tsx` last measured it: the
 * panels it folded to their headers and the ones it gathered into its More
 * row. The one place that measurement is kept, so the rail draws from it
 * and the window's answer about its panels (./panelMounts.ts) says where a
 * panel went without measuring the rail a second time. Window state, never
 * a record: a rail that is not drawn holds nothing.
 */

const EMPTY: RailRoom = { folded: new Set(), hidden: new Set() };

let rooms: Readonly<Record<RailSide, RailRoom>> = { left: EMPTY, right: EMPTY };
const listeners = new Set<() => void>();

function same(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export const railFolds = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** One rail's room as last measured; the same object until it changes. */
  of(side: RailSide): RailRoom {
    return rooms[side];
  },
  /** The rail measured again: kept, and heard, only when its folds changed. */
  note(side: RailSide, room: RailRoom): void {
    const before = rooms[side];
    if (same(before.folded, room.folded) && same(before.hidden, room.hidden)) return;
    rooms = { ...rooms, [side]: room };
    for (const listener of [...listeners]) listener();
  },
  /** The rail is no longer drawn, so it folds nothing. */
  clear(side: RailSide): void {
    railFolds.note(side, EMPTY);
  },
};

export function useRailFolds(side: RailSide): RailRoom {
  const read = () => railFolds.of(side);
  return useSyncExternalStore(railFolds.subscribe, read, read);
}
