import { partsStatusOf } from "@shared/recordAttention";
import type { TaskView } from "@shared/tasks";

/**
 * Each view's `partsStatus` read from the views of its parts among these
 * (INF-6805's plan, piece 2): a part's own status word is read only once its
 * own parts are settled, so a parent of a parent follows its deepest work.
 * A part the views leave out is not counted. Answers the views whose
 * `partsStatus` moved, each a new object; every other view keeps its
 * identity, so a board push carries only the parents that moved.
 */
export function settlePartsStatus(views: ReadonlyMap<string, TaskView>): Map<string, TaskView> {
  const partIds = new Map<string, string[]>();
  for (const view of views.values()) {
    if (!view.parentId || !views.has(view.parentId)) continue;
    const ids = partIds.get(view.parentId);
    if (ids) ids.push(view.id);
    else partIds.set(view.parentId, [view.id]);
  }
  const settled = new Map<string, TaskView>();
  const moved = new Map<string, TaskView>();
  // A row met again while its own parts are read would be a loop of parents,
  // which the graph refuses to write; it is read as it stands rather than
  // recursing without end.
  const reading = new Set<string>();
  const settle = (id: string): TaskView => {
    const done = settled.get(id);
    if (done) return done;
    const view = views.get(id) as TaskView;
    if (reading.has(id)) return view;
    reading.add(id);
    const ids = partIds.get(id) ?? [];
    const parts = ids.map((part) => settle(part));
    const status = ids.length > 0 ? partsStatusOf(view, parts) : undefined;
    let next = view;
    if (view.partsStatus !== status) {
      const { partsStatus: _was, ...rest } = view;
      next = status ? { ...rest, partsStatus: status } : rest;
      moved.set(id, next);
    }
    settled.set(id, next);
    return next;
  };
  for (const id of views.keys()) settle(id);
  return moved;
}
