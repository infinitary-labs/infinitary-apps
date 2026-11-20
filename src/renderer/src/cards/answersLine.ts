import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/**
 * The footer's queue line (inline decisions, contract 4.22). On a decision:
 * how many required questions still wait for an answer ("1 to answer"), or
 * once none does, how many questions are picked ("1 of 3 picked"); then how
 * many questions the captain may skip are left to send their Default
 * (INF-4425, "2 defaults"); then how many answers differ from what the card
 * proposed, only when any do: "1 of 3 picked · 2 defaults · 1 changed". A
 * playable preview body (`isPlayableBody`) counts its settings answered and
 * has no defaults.
 */
export function answersLine(
  count: {
    answered: number;
    of: number;
    changed: number;
    unanswered?: number;
    defaults?: number;
  },
  preview: boolean,
): string {
  const numbers = { answered: formatNumber(count.answered), total: formatNumber(count.of) };
  const unanswered = preview ? 0 : (count.unanswered ?? 0);
  const defaults = preview ? 0 : (count.defaults ?? 0);
  const counted = preview
    ? m.cardAnswersAnswered(numbers)
    : unanswered > 0
      ? m.cardAnswersToAnswer({ count: unanswered })
      : m.cardAnswersPicked(numbers);
  const withDefaults = defaults > 0 ? m.cardAnswersDefaults({ counted, count: defaults }) : counted;
  return count.changed > 0
    ? m.cardAnswersChanged({ counted: withDefaults, changed: formatNumber(count.changed) })
    : withDefaults;
}
