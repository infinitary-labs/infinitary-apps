import { cardAnswerLines } from "@shared/cardAnswerLines";
import { DECLINE_ACTION_ID } from "@shared/cardLeave";
import type { PastCard } from "@shared/cards";
import { cardChoiceQuestions } from "../pi/cardLint";

/** A refusal's words for a repeated question; a scripted stand-in recognizes them. */
// i18n-exempt: part of a refusal served to the card's author, never shown to a person
export const ANSWERED_QUESTION_WORDS = "already answered this question";

/**
 * The refusal of a card that asks the captain a question they already
 * answered (INF-6523 part 4), or undefined. A question repeats one on a
 * closed card when both carry the same control name with the same option
 * values, whatever the title, legend or body say, and the captain closed
 * the earlier card with a choice that is not a decline or a put-off: only
 * then does their answer settle it. The refusal shows the earlier question,
 * its options, the answer and when, because the author judges whether the
 * question is really the same, and `asks_again` sends it anyway.
 */
export function answeredQuestionRefusal(
  body: string,
  earlier: readonly PastCard[],
  skip: ReadonlySet<string>,
): string | undefined {
  const asked = cardChoiceQuestions(body).filter((question) => question.values.length > 0);
  if (asked.length === 0) return undefined;
  for (const past of earlier) {
    if (skip.has(past.id) || !settledBy(past)) continue;
    const previous = cardChoiceQuestions(past.body);
    for (const question of asked) {
      const match = previous.find(
        (entry) => entry.name === question.name && sameValues(entry.values, question.values),
      );
      const answer = past.answers.find((entry) => entry.name === question.name);
      if (!match || !answer) continue;
      // i18n-exempt: part of a refusal served to the card's author
      const choice = past.ending.label ?? past.ending.actionId ?? "an action";
      // i18n-exempt: a refusal served to the card's author, never shown to a person
      return [
        `Card refused: the captain ${ANSWERED_QUESTION_WORDS} on card "${past.id}" ("${past.title}"), closed at ${new Date(past.ending.at).toISOString()} by choosing "${choice}".`,
        `Its question "${question.name}"${match.legend ? ` asked: ${JSON.stringify(match.legend)}` : ""}, with the options ${match.values.map((value) => JSON.stringify(value)).join(", ")}.`,
        `Their answers:\n${cardAnswerLines(past.answers).join("\n")}`,
        `That answer settles the question: act on it and raise no card for it. If the facts it was answered on changed, or this is a different question under the same name, emit again with asks_again {card: "${past.id}", why}, and open the card with their earlier answer and what changed. Nothing was shown.`,
      ].join("\n");
    }
  }
  return undefined;
}

/** Whether the captain's close answered the card: a choice that neither declines nor puts it off. */
function settledBy(past: PastCard): boolean {
  if (past.ending.how !== "chose" || (past.ending.by ?? "captain") !== "captain") return false;
  if (past.ending.actionId === DECLINE_ACTION_ID) return false;
  const chosen = past.actions.find((action) => action.id === past.ending.actionId);
  return !chosen?.declines && !chosen?.until;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
