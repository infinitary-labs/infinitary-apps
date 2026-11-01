import type { PanelTaskBoard } from "@infinitary/contracts";

/**
 * The board as the panel keeps it (INF-2105, on INF-2078's accepted plan:
 * "every row stays in the page; only the redraw and the measuring are
 * narrowed to what changed"). Each push of `tasks.board` crosses the
 * bridge as a new copy, so a row the change never touched would still be
 * a new object, and every memoized row would paint again. Reconciling the
 * push against the board the panel holds keeps the earlier object for each
 * task and project whose fields read the same, and the earlier board
 * itself when none moved - then nothing paints at all.
 */
export function reconcileBoard(
  current: PanelTaskBoard | null,
  next: PanelTaskBoard,
): PanelTaskBoard {
  if (!current) return next;
  const tasks = keepUnchanged(current.tasks, next.tasks);
  const projects = keepUnchanged(current.projects, next.projects);
  if (tasks === current.tasks && projects === current.projects) return current;
  return { ...next, tasks, projects };
}

/**
 * `next`'s rows, each replaced by `current`'s object for the same id when
 * the two read the same; `current` itself when every row kept its place.
 */
function keepUnchanged<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const earlier = new Map(current.map((row) => [row.id, row]));
  let samePlaces = current.length === next.length;
  const kept = next.map((row, index) => {
    const was = earlier.get(row.id);
    const keep = was !== undefined && sameValue(was, row) ? was : row;
    if (keep !== current[index]) samePlaces = false;
    return keep;
  });
  return samePlaces ? (current as T[]) : kept;
}

/** Structural equality over what crosses the bridge: plain objects, arrays and primitives. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
