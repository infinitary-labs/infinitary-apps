/**
 * The app's own lines in a card's thread, written by the core as host
 * messages so every view draws the same words.
 */

const REVISED_PREFIX = "revised: ";

/** The line a revision of the card writes under the captain's reply. */
export function revisedLineWords(title: string): string {
  return `${REVISED_PREFIX}${title}`;
}

/**
 * Whether a host line is a revision's: only a revision carries change
 * links, so only one saved before they were kept says its links are
 * unavailable.
 */
export function isRevisedLine(text: string): boolean {
  return text.startsWith(REVISED_PREFIX);
}

/**
 * The line naming the work a captain's reply under a card started
 * (INF-3071's plan, its second change; INF-3060 finding 5: three replies on
 * crewmate cards went to the first mate, and nothing in their threads said
 * what became of them). The first mate names the card when it starts the
 * work (`spawn_crewmate`'s `from_card`), and the window links the task's key
 * as it links every key it draws.
 */
export function startedLineWords(key: string, queued: boolean): string {
  return queued
    ? `Your first mate filed ${key} from your reply here. It starts when its wait ends.`
    : `Your first mate started ${key} from your reply here.`;
}
