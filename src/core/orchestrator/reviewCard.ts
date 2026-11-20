import { type Card, mergeEffectOf } from "@shared/cards";

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

/**
 * The reviewer's questions about the task still waiting on the captain
 * (INF-5396's audit, finding 2): each Review finding card with a choice
 * open. They bear on whether the reviewed work is right, so the task's
 * merge card names them and its merge waits for their answers.
 */
export function openReviewQuestions<
  C extends Pick<Card, "author" | "taskId" | "reviewTaskId" | "actions">,
>(cards: Iterable<C>, taskId: string, tasks: ParentReader): C[] {
  return [...cards].filter(
    (card) =>
      card.actions.length > 0 &&
      !card.actions.some((action) => mergeEffectOf(action)) &&
      reviewedTaskOf(card, tasks) === taskId,
  );
}
