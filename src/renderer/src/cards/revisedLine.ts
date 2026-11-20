import type { CardChanges } from "@shared/cards";
import { formatDate, formatNumber, formatTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/**
 * The quiet line under a revised card's title (design skill ResponseCard,
 * "revised line"): when the version on the stage was written, then how
 * many of its parts are new since the captain last saw the card and how
 * many of that version's parts are gone, each only when it is not zero -
 * "Revised 14:02 · 2 parts new · 1 removed". More than half new reads
 * "Rewritten 14:02", and the body draws no bars.
 */
export function revisedLine(changes: CardChanges, now: number = Date.now()): string {
  const time = clock(changes.at, now);
  if (changes.rewritten) return m.cardRevisedRewritten({ time });
  const clauses = [m.cardRevisedRevised({ time })];
  if (changes.added > 0) clauses.push(m.cardRevisedPartsNew({ count: changes.added }));
  if (changes.removed > 0) {
    clauses.push(
      changes.added > 0
        ? m.cardRevisedRemoved({ count: formatNumber(changes.removed) })
        : m.cardRevisedPartsRemoved({ count: changes.removed }),
    );
  }
  return clauses.join(" · ");
}

/** The time of day, with the date in front when it was not today. */
export function clock(at: number, now: number): string {
  const date = new Date(at);
  const time = formatTime(date, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${formatDate(date, { month: "short", day: "numeric" })}, ${time}`;
}
