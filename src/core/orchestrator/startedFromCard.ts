import type { CardMessage, CardMessageWho, CardThread } from "@shared/cards";
import { startedLineWords } from "@shared/threadLines";

/** What writing the line needs of the card service. */
export type StartedLineCards = {
  thread(cardId: string): CardThread;
  addMessage(cardId: string, who: CardMessageWho, text: string): CardMessage;
};

/**
 * The first mate started work from the captain's reply under a card
 * (`spawn_crewmate`'s `from_card`): the app writes a line in that card's
 * thread naming the task, on an open card, an ended one still on the
 * stack, or one already closed. The one fact the host checks is its own:
 * the thread holds a reply from the captain. Answers what it did, in words
 * for the first mate's tool result.
 */
export function writeStartedLine(
  cards: StartedLineCards,
  cardId: string,
  task: { key: string },
  queued: boolean,
): string {
  const id = cardId.trim();
  const replied = cards.thread(id).messages.some((message) => message.who === "captain");
  if (!replied)
    return ` No line was written under card ${id}: the captain has not replied under it.`;
  cards.addMessage(id, "host", startedLineWords(task.key, queued));
  return ` The app wrote a line under card ${id} naming ${task.key}.`;
}
