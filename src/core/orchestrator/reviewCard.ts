import type { Card } from "@shared/cards";

type ParentReader = { get(id: string): { parentId?: string | null } | undefined };

/**
 * The builder a reviewer's own Review finding card asks about (INF-4338's
 * direction D), or undefined for any other card. The card stays its
 * reviewer's - its thread and revisions are the review task's - while the
 * question is the builder's: its facts, its choice, and what it holds open.
 */
export function reviewedTaskOf(
  card: Pick<Card, "author" | "taskId" | "reviewTaskId">,
  tasks: ParentReader,
): string | undefined {
  if (card.author !== "crewmate" || !card.reviewTaskId || card.taskId !== card.reviewTaskId)
    return undefined;
  return tasks.get(card.reviewTaskId)?.parentId ?? undefined;
}

/** Whether a card asks about the task: it is on it, or its reviewer asks about it. */
export function asksAbout(
  card: Pick<Card, "author" | "taskId" | "reviewTaskId">,
  taskId: string,
  tasks: ParentReader,
): boolean {
  return card.taskId === taskId || reviewedTaskOf(card, tasks) === taskId;
}
