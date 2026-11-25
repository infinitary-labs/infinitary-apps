import type { ListGroup } from "./rows";

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
  | { kind: "group"; key: string; group: ListGroup; open: boolean; taskIds: readonly string[] }
  | { kind: "row"; key: string; group: ListGroup };

export type NavGroup = {
  group: ListGroup;
  open: boolean;
  collapsible: boolean;
  taskIds: readonly string[];
  /** Grouped by tag: its rows' stops are their tasks' in this group (`rowNavKey`). */
  byTag?: boolean;
};

export const groupNavKey = (group: ListGroup): string => `group:${group}`;
/**
 * A row's stop is its task's, whatever group lists it: a task that moves to
 * another group (queued to working as its crewmate begins) keeps its stop.
 * Grouped by tag, a task with two tags lists in two groups, so a row there
 * is its task's in its tag group.
 */
export const rowNavKey = (taskId: string, tagGroup?: string): string =>
  tagGroup === undefined ? `row:${taskId}` : `row:${taskId}@${tagGroup}`;

/** The task a row's stop is, whichever grouping drew it; null for a group's header. */
const taskOfStop = (key: string | null): string | null =>
  key?.startsWith("row:") ? (key.slice("row:".length).split("@")[0] ?? null) : null;

/** Every stop in the list, in the order the arrows move through them. */
export function nowNavItems(groups: readonly NavGroup[]): NowNavItem[] {
  const items: NowNavItem[] = [];
  for (const { group, open, collapsible, taskIds, byTag } of groups) {
    if (collapsible) items.push({ kind: "group", key: groupNavKey(group), group, open, taskIds });
    if (open)
      for (const id of taskIds)
        items.push({ kind: "row", key: rowNavKey(id, byTag ? group : undefined), group });
  }
  return items;
}

/**
 * The stop that holds the list's one Tab stop: the one focus was last on,
 * while it is still listed - a row whose task moved to another open group
 * included - or the header of the closed group its task moved into, or
 * else the first.
 */
export function rovingKey(items: readonly NowNavItem[], last: string | null): string | null {
  if (last !== null && items.some((item) => item.key === last)) return last;
  const task = taskOfStop(last);
  const row = items.find((item) => item.kind === "row" && taskOfStop(item.key) === task);
  const holder = items.find((item) => item.kind === "group" && item.taskIds.includes(task ?? ""));
  return row?.key ?? holder?.key ?? items[0]?.key ?? null;
}

export type NowNavMove = { focus: string } | { toggle: ListGroup } | null;

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
    case "ArrowRight":
      if (item.kind !== "group") return null;
      if (!item.open) return { toggle: item.group };
      return items[at + 1]?.kind === "row" ? to(at + 1) : null;
    case "ArrowLeft":
      if (item.kind === "group") return item.open ? { toggle: item.group } : null;
      return to(items.findIndex((other) => other.kind === "group" && other.group === item.group));
    default:
      return null;
  }
}
