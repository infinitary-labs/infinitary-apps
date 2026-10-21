import { anythingElseOf, type Card, type CardAnswer, isPreviewBody } from "@shared/cards";
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
 * Whether closing would discard words in the Anything else? box (INF-680):
 * there are some, and they are not what the card last sent.
 */
export function unsentComment(words: string | undefined, sent: CardAnswer[] | undefined): boolean {
  const written = words?.trim() ?? "";
  return written !== "" && written !== anythingElseOf(sent);
}
