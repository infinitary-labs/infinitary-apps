import { cardAnswerLines } from "@shared/cardAnswerLines";
import { DECLINE_ACTION_ID } from "@shared/cardLeave";
import type { PastCard } from "@shared/cards";
import { cardChoiceQuestions } from "../pi/cardLint";
import { answersWithAuthorWordsMarked } from "./readerData";

/** A refusal's words for a repeated question; a scripted stand-in recognizes them. */
// i18n-exempt: part of a refusal served to the card's author, never shown to a person
export const ANSWERED_QUESTION_WORDS = "already answered this question";

/**
 * The refusal of a card that asks the captain a question they already
 * answered (INF-6523 part 4), or undefined. A question repeats one on a
 * closed card when both carry the same control name with the same option
 * values, whatever the title, legend or body say, and the captain closed
 * the earlier card with a choice that is not a decline or a put-off: only
 * then does their answer settle it. Only the newest such card counts, so a
 * question asked again on purpose is settled by its latest answer, and
 * `asks_again` naming that card sends it once more. The refusal shows the
 * earlier question, its options, the answer and when, because the author
 * judges whether the question is really the same; `mark` serves an unsafe
 * data reader's card's words as data. The earlier cards are read only for
 * a body that asks a choice question.
 */
export function answeredQuestionRefusal(
  body: string,
  earlier: () => readonly PastCard[],
  pass: { revising?: string; asksAgain?: string },
  mark: (card: PastCard, words: string) => string,
): string | undefined {
  const asked = cardChoiceQuestions(body).filter((question) => question.values.length > 0);
  if (asked.length === 0) return undefined;
  const settled = earlier()
    .filter((past) => past.id !== pass.revising && settledBy(past))
    .sort((a, b) => b.ending.at - a.ending.at);
  for (const question of asked) {
    const newest = settled.flatMap((past) => {
      const match = cardChoiceQuestions(past.body).find(
        (entry) => entry.name === question.name && sameValues(entry.values, question.values),
      );
      return match && past.answers.some((entry) => entry.name === question.name)
        ? [{ past, match }]
        : [];
    })[0];
    if (!newest || newest.past.id === pass.asksAgain) continue;
    const { past, match } = newest;
    const words = (text: string) => mark(past, text);
    // i18n-exempt: part of a refusal served to the card's author
    const choice = words(past.ending.label ?? past.ending.actionId ?? "an action");
    const answers = cardAnswerLines(answersWithAuthorWordsMarked(past.answers, words));
    // i18n-exempt: a refusal served to the card's author, never shown to a person
    return [
      `Card refused: the captain ${ANSWERED_QUESTION_WORDS} on card "${past.id}" ("${words(past.title)}"), closed at ${new Date(past.ending.at).toISOString()} by choosing "${choice}".`,
      `Its question "${words(question.name)}"${match.legend ? ` asked: ${JSON.stringify(words(match.legend))}` : ""}, with the options ${match.values.map((value) => JSON.stringify(words(value))).join(", ")}.`,
      `Their answers:\n${answers.join("\n")}`,
      `That answer settles the question: act on it and raise no card for it. If the facts it was answered on changed, emit again with asks_again {card: "${past.id}", why}, and open the card with their earlier answer and what changed. A different question that only shares this name takes a name of its own. Nothing was shown.`,
    ].join("\n");
  }
  return undefined;
}

/** Whether the captain answered the card: their choice, neither a decline nor a put-off. */
function settledBy(past: PastCard): boolean {
  if (past.ending.how !== "chose" || past.ending.by !== "captain") return false;
  if (past.ending.actionId === DECLINE_ACTION_ID) return false;
  const chosen = past.actions.find((action) => action.id === past.ending.actionId);
  return !chosen?.declines && !chosen?.until;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
