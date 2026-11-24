import type { Card } from "@shared/cards";
import { isQuickAnswer, type WorkKind } from "@shared/routingPolicy";

type Shaped = {
  shape?: { kind?: WorkKind; internal_step?: boolean; unsafe_data_reader?: boolean } | null;
};

/**
 * The marks a crewmate's card wears from its task's recorded shape, never
 * from the card's words: Quick answer (INF-4344) for a task sorted as a
 * quick answer (`isQuickAnswer`), and the unsafe data line for an unsafe
 * data reader's card (`readerWroteCard`).
 */
export function cardShapeMarks(
  tasks: { get(id: string): Shaped | undefined },
  card: Pick<Card, "author" | "taskId">,
): { quick?: true; unsafeData?: true } {
  if (card.author !== "crewmate" || !card.taskId) return {};
  const shape = tasks.get(card.taskId)?.shape;
  return {
    ...(isQuickAnswer(shape) ? { quick: true as const } : {}),
    ...(shape?.unsafe_data_reader === true ? { unsafeData: true as const } : {}),
  };
}
