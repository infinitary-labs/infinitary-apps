import {
  anythingElseOf,
  type Card,
  type CardAnswer,
  type CardMessage,
  isPreviewBody,
} from "@shared/cards";
import type { FrameAnswers } from "@shared/plugins/bridge";

/** Before the first send, retain the bridge's authored-proposal semantics.
 * After a send, only the answer values (not labels or proposal flags) can be lost.
 * Include cleared answers: returning to the proposal is still an unsent edit.
 */
export function unsentAnswers(
  card: Card,
  reading: FrameAnswers | undefined,
  sent: CardAnswer[] | undefined,
): number {
  if (!reading) return 0;
  if (!sent) return isPreviewBody(card.body) ? reading.changed : reading.picked;
  const before = new Map(sent.map((answer) => [answer.name, answer]));
  // A question removed by the author is not an edit the captain can discard.
  return reading.answers.filter((answer) => {
    const previous = before.get(answer.name);
    if (!previous)
      return answer.changed || answer.values.length > 0 || answer.written !== undefined;
    return (
      answer.written !== previous.written ||
      answer.json !== previous.json ||
      JSON.stringify([...answer.values].sort()) !== JSON.stringify([...previous.values].sort())
    );
  }).length;
}

/**
 * Whether closing would discard words in the card's one field (INF-924):
 * there are some, and they are not what the card last sent with a choice.
 */
export function unsentComment(words: string | undefined, sent: CardAnswer[] | undefined): boolean {
  const written = words?.trim() ?? "";
  return written !== "" && written !== anythingElseOf(sent);
}

/**
 * Whether the captain's reply still waits on its answer (INF-770), so a
 * close leaves the answer to the record instead of the card: the card's
 * own hold says so, which an author's interim line keeps (INF-990
 * friction 3), or his line is the newest on the card's thread.
 */
export function replyUnanswered(
  card: Pick<Card, "awaiting">,
  messages: readonly CardMessage[] | undefined,
): boolean {
  return card.awaiting === "answer" || messages?.at(-1)?.who === "captain";
}
