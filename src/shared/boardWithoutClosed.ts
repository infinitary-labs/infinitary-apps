import { nowGroupOf } from "./nowPanel";
import type { TaskBoard, TaskView } from "./tasks";

/**
 * The board without its closed rows (`inf:tasks:board` with `{ closed: false }`):
 * the first read a view makes when it comes back,
 * which a week of closed work would otherwise hold up (INF-3750: 1.74 MB of a
 * 1,650-row board against 0.24 MB without the closed rows).
 *
 * It keeps every open and active row; every pinned row; every closed row
 * that is a part of an open or active row, so live work's parts still count
 * its finished ones; every row that is the task of a card on the stack
 * (`cardTasks`), so a card still finds its own task; every closed row Tasks
 * lists in a group other than Done, such as an answer still waiting to be
 * read; and the parents of every
 * row it keeps, as the whole board does. Links keep both ends on it, and
 * the projects and their counts are the whole board's. The rows it leaves
 * out that Tasks lists under Done are named in `closedLeftOut.done` by project, so the
 * Done group still says how many there are before a client reads them.
 */
export function boardWithoutClosed(board: TaskBoard, cardTasks: ReadonlySet<string>): TaskBoard {
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const live = (task: TaskView | undefined) =>
    task !== undefined && (task.status === "open" || task.status === "active");
  const kept = new Set<string>();
  for (const task of board.tasks) {
    if (
      live(task) ||
      task.pinnedAt !== undefined ||
      cardTasks.has(task.id) ||
      shownBeforeDone(task) ||
      (task.parentId !== null && live(byId.get(task.parentId)))
    )
      kept.add(task.id);
  }
  // The parents of every row kept, as the whole board carries them.
  for (const id of [...kept]) {
    let parentId = byId.get(id)?.parentId ?? null;
    while (parentId !== null && !kept.has(parentId) && byId.has(parentId)) {
      kept.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  const done: Record<string, string[]> = {};
  for (const task of board.tasks) {
    if (kept.has(task.id) || nowGroupOf(task) !== "landed") continue;
    done[task.projectId] ??= [];
    done[task.projectId]?.push(task.id);
  }
  return {
    seq: board.seq,
    at: board.at,
    projects: board.projects,
    tasks: board.tasks.filter((task) => kept.has(task.id)),
    links: board.links.filter((link) => kept.has(link.fromId) && kept.has(link.toId)),
    closedLeftOut: { done },
  };
}

/** A closed row Tasks lists outside Done, such as an answer waiting to be read. */
function shownBeforeDone(task: TaskView): boolean {
  const group = nowGroupOf(task);
  return group !== null && group !== "landed";
}
