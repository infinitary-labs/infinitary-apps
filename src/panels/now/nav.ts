import type { PanelGroup } from "./rows";

/**
 * The Tasks list's keys (docs/keyboard.md, "Lists and Settings"): the list
 * is one Tab stop, and the arrows move through it the way a tree of groups
 * moves. Pure, so the panel (./panel.tsx) runs it and a unit test reads it.
 *
 * What the keys reach, in the order the list paints them: the header of a
 * group that opens and closes, and every row of an open group. The header
 * of a group that is always open is a label, not a stop.
 */

export type NowNavItem =
  | { kind: "group"; key: string; group: PanelGroup; open: boolean }
  | { kind: "row"; key: string; group: PanelGroup };

/** A painted group, as the list draws it. */
export type NavGroup = {
  group: PanelGroup;
  open: boolean;
  /** Its header opens and closes it. */
  collapsible: boolean;
  /** The ids of the tasks it lists, in order. */
  taskIds: readonly string[];
};

export const groupNavKey = (group: PanelGroup): string => `group:${group}`;
export const rowNavKey = (group: PanelGroup, taskId: string): string => `row:${group}:${taskId}`;

/** Every stop in the list, in the order the arrows move through them. */
export function nowNavItems(groups: readonly NavGroup[]): NowNavItem[] {
  const items: NowNavItem[] = [];
  for (const { group, open, collapsible, taskIds } of groups) {
    if (collapsible) items.push({ kind: "group", key: groupNavKey(group), group, open });
    if (open)
      for (const id of taskIds) items.push({ kind: "row", key: rowNavKey(group, id), group });
  }
  return items;
}

/**
 * The stop that holds the list's one Tab stop: the one focus was last on,
 * while it is still listed, or else the first.
 */
export function rovingKey(items: readonly NowNavItem[], last: string | null): string | null {
  if (last !== null && items.some((item) => item.key === last)) return last;
  return items[0]?.key ?? null;
}

/** What a key does from one stop: move focus to another, open or close a group, or nothing. */
export type NowNavMove = { focus: string } | { toggle: PanelGroup } | null;

export function nowNavMove(items: readonly NowNavItem[], from: string, key: string): NowNavMove {
  const at = items.findIndex((item) => item.key === from);
  const item = items[at];
  if (!item) return null;
  const to = (index: number): NowNavMove => {
    const target = items[index];
    return target && index !== at ? { focus: target.key } : null;
  };
  switch (key) {
    case "ArrowDown":
      return to(at + 1);
    case "ArrowUp":
      return to(at - 1);
    case "Home":
      return to(0);
    case "End":
      return to(items.length - 1);
    // → opens a closed group, then steps into it.
    case "ArrowRight":
      if (item.kind !== "group") return null;
      if (!item.open) return { toggle: item.group };
      return items[at + 1]?.kind === "row" ? to(at + 1) : null;
    // ← closes an open group, and from a row goes up to its group's header.
    case "ArrowLeft":
      if (item.kind === "group") return item.open ? { toggle: item.group } : null;
      return to(items.findIndex((other) => other.kind === "group" && other.group === item.group));
    default:
      return null;
  }
}
