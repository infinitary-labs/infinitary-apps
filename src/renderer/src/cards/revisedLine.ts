import type { CardChanges } from "@shared/cards";

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
  if (changes.rewritten) return `Rewritten ${time}`;
  const clauses = [`Revised ${time}`];
  if (changes.added > 0) clauses.push(`${count(changes.added, "part")} new`);
  if (changes.removed > 0) {
    clauses.push(
      changes.added > 0
        ? `${changes.removed} removed`
        : `${count(changes.removed, "part")} removed`,
    );
  }
  return clauses.join(" · ");
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** The time of day, with the date in front when it was not today. */
export function clock(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
