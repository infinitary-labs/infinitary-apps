import { type Card, isReadyDecision } from "./cards";
import { cardMerges, taskMovesOf } from "./taskMoves";
import type { ProjectView, TaskBoard, TaskView } from "./tasks";

/** Reconcile a wire waiting shortcut with the stack the shell can focus now.
 * Direct siblings use stage order; a gate-backed association uses the wire id.
 * The core admits the association first; locally only mask it or choose an
 * eligible sibling. Never invent waiting ahead of the board, or change holds.
 */
export function presentTask<T extends TaskView>(task: T, cards: readonly Card[]): T {
  const waitingCard =
    task.waitingCardId && (task.status === "open" || task.status === "active")
      ? cards.find(
          (card) =>
            isReadyDecision(card) && (card.taskId === task.id || card.id === task.waitingCardId),
        )
      : undefined;
  const waitingCardId = waitingCard?.id ?? null;
  if (waitingCardId === task.waitingCardId) return task;
  // The card it waits on is another one here, or none: whether it merges,
  // and the moves the record's rule reads from it, follow (src/shared/taskMoves.ts).
  const { waitingCardMerges: _merges, moves: _moves, ...rest } = task;
  const presented = { ...rest, waitingCardId } as T;
  const moves = taskMovesOf(presented);
  return {
    ...presented,
    ...(cardMerges(waitingCard) ? { waitingCardMerges: true as const } : {}),
    ...(moves ? { moves } : {}),
  };
}

export function presentProjects(
  projects: ProjectView[],
  tasks: readonly TaskView[],
): ProjectView[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (
      task.waitingCardId ||
      (task.requiredAction && (task.status === "open" || task.status === "active"))
    ) {
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
    }
  }
  return projects.map((project) => ({
    ...project,
    counts: { ...project.counts, waitingOnYou: counts.get(project.id) ?? 0 },
  }));
}

export function presentBoard(board: TaskBoard, cards: readonly Card[]): TaskBoard {
  const tasks = board.tasks.map((task) => presentTask(task, cards));
  return { ...board, tasks, projects: presentProjects(board.projects, tasks) };
}
