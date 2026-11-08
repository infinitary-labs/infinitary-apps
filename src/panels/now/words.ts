/**
 * The words a Tasks row and its group header read, in a module of words
 * alone, so a journey and the phone's generated words read them from their
 * owner (scripts/generate-phone-contract.ts).
 */

/** A backlog row's Start (INF-1663): the task record's own, Start, and Try again after a start that failed. */
export const ROW_START_LABEL = "Start";
export const ROW_TRY_AGAIN_LABEL = "Try again";

/** The one dim word a row may carry after its title (`wordOf`). */
export const ROW_WORDS = {
  starting: "starting",
  couldNotStart: "could not start",
  checks: "checks",
  waiting: "waiting",
  blocked: "blocked",
  held: "held",
} as const;

/** The word of a row a crewmate filed while working on another task. */
export function foundOnWords(key: string): string {
  return `found on ${key}`;
}

/** Why a row's computer cannot take work now (`rowTrailing`). */
export const ROW_REACH_WORDS = {
  connecting: "connecting",
  noNewWork: "takes no new work",
  away: "out of reach",
} as const;

/**
 * What a row says while its computer is connected and this Mac is still
 * catching up with the task (`rowTrailing`); since when is the status's
 * reason, which the row's summary shows, since the rail has no room for it.
 */
export const ROW_CATCHING_UP = "catching up";

/** What a folding group's header adds after its count: crew filings not yet opened. */
export function newCountWords(count: number): string {
  return ` · ${count} new`;
}

/** What the Backlog header adds after its count: starts that failed. */
export function failedCountWords(count: number): string {
  return ` · ${count} could not start`;
}

/** The search's own group of older closed work. */
export const EARLIER_LABEL = "earlier";
