import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/**
 * The footer's queue line (inline decisions, contract 4.22): how many of the
 * questions the body asks have an answer - picked, or answered on a preview
 * body - then how many of those differ from what the card proposed, only
 * when any do: "2 of 3 picked · 2 changed".
 */
export function answersLine(
  count: { answered: number; of: number; changed: number },
  preview: boolean,
): string {
  const numbers = { answered: formatNumber(count.answered), total: formatNumber(count.of) };
  const counted = preview ? m.cardAnswersAnswered(numbers) : m.cardAnswersPicked(numbers);
  return count.changed > 0
    ? m.cardAnswersChanged({ counted, changed: formatNumber(count.changed) })
    : counted;
}
