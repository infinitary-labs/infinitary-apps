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
 * for the first mate's tool result, and the captain's reply it wrote the
 * line under: the line the action's message was saved as when it was typed
 * under this card (`typedLine`, INF-6115 piece 3), else his newest there,
 * as on a crewmate's card, whose replies open no message.
 */
export function writeStartedLine(
  cards: StartedLineCards,
  cardId: string,
  task: { key: string },
  queued: boolean,
  typedLine?: number,
): StartedLine {
  const id = cardId.trim();
  const captain = cards.thread(id).messages.filter((message) => message.who === "captain");
  const reply =
    (typedLine !== undefined ? captain.find((message) => message.id === typedLine) : undefined) ??
    captain.at(-1);
  if (!reply)
    return { text: ` No line was written under card ${id}: the captain has not replied under it.` };
  cards.addMessage(id, "host", startedLineWords(task.key, queued));
  return { text: ` The app wrote a line under card ${id} naming ${task.key}.`, reply };
}
