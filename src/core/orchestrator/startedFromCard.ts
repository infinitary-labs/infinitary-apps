import type { CardMessage, CardMessageWho, CardThread } from "@shared/cards";
import { startedLineWords } from "@shared/threadLines";

export type StartedLineCards = {
  thread(cardId: string): CardThread;
  addMessage(cardId: string, who: CardMessageWho, text: string): CardMessage;
};

/** What the line's writing answers: its words, and the captain's reply it was written under. */
export type StartedLine = { text: string; reply?: CardMessage };

/**
 * The first mate started work from the captain's reply under a card
 * (`spawn_crewmate`'s `from_card`): the app writes a line in that card's
 * thread naming the task, on an open card, an ended one still on the
 * stack, or one already closed. The one fact the host checks is its own:
 * the thread holds a reply from the captain. Answers what it did, in words
 * for the first mate's tool result, and the captain's newest reply when it
 * wrote the line.
 */
export function writeStartedLine(
  cards: StartedLineCards,
  cardId: string,
  task: { key: string },
  queued: boolean,
): StartedLine {
  const id = cardId.trim();
  const reply = cards.thread(id).messages.findLast((message) => message.who === "captain");
  if (!reply)
    return { text: ` No line was written under card ${id}: the captain has not replied under it.` };
  cards.addMessage(id, "host", startedLineWords(task.key, queued));
  return { text: ` The app wrote a line under card ${id} naming ${task.key}.`, reply };
}
