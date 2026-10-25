import { type Card, isReadyDecision } from "./cards";
import { cardMerges, taskMovesOf } from "./taskMoves";
import type { ProjectView, TaskBoard, TaskView } from "./tasks";

/** Reconcile a wire waiting shortcut with the stack the shell can focus now.
 * Direct siblings use stage order; a gate-backed association uses the wire id.
 * The core admits the association first; locally only mask it or choose an
 * eligible sibling. Never invent waiting ahead of the board, or change holds.
 */
export function presentTask<T extends TaskView>(task: T, cards: readonly Card[]): T {
  const associated = (card: Card) => card.taskId === task.id || card.id === task.waitingCardId;
  // INF-1293: putting a card aside does not give the captain the turn while
  // its author works or owes a reply. This masks only the placement shortcut:
  // openTask still restores the actual minimized cards, and ready decisions
  // and required captain actions keep their independent waiting associations.
  const authorWorking =
    task.status === "active" &&
    (task.workPosture?.state === "active" ||
      (!task.workPosture && task.activity === "running") ||
      cards.some((card) => associated(card) && card.awaiting === "answer"));
  const minimized = authorWorking
    ? undefined
    : cards.find((card) => card.minimized && associated(card));
  if (task.minimizedCardId !== minimized?.id) {
    const { minimizedCardId: _old, ...raw } = task;
    task = { ...raw, ...(minimized ? { minimizedCardId: minimized.id } : {}) } as T;
  }
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
      task.minimizedCardId ||
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
  // A taskless message has no record to open. This is a row projection, never a saved task.
  for (const card of cards) {
    if (
      !card.minimized ||
      tasks.some((task) => task.minimizedCardId === card.id || task.id === card.taskId)
    )
      continue;
    if (card.taskId) continue;
    tasks.push({
      id: minimizedRowId(card.id),
      key: "",
      projectId: "",
      parentId: null,
      kind: "operation",
      title: card.title,
      goal: null,
      priority: card.priority,
      status: "open",
      activity: null,
      closedReason: null,
      startPolicy: "on-request",
      flags: { blocked: false, held: false, needsYou: false, ready: false },
      blockedBy: [],
      blocks: [],
      children: { total: 0, closed: 0 },
      assignee: null,
      model: null,
      tier: null,
      repo: null,
      delivery: null,
      outcomeSummary: null,
      waitingCardId: null,
      minimizedCardId: card.id,
      createdAt: card.createdAt,
      updatedAt: card.createdAt,
      startedAt: null,
      closedAt: null,
    });
  }
  return { ...board, tasks, projects: presentProjects(board.projects, tasks) };
}

/** Stable id for the presentation-only row of a card with no task. */
export const minimizedRowId = (cardId: string): string => `minimized-card:${cardId}`;
