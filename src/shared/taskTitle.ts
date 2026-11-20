// A task's title: the one line the board, the feed, a card's strip and the
// task's record show for it. An author naming a task - the first mate's
// spawn_crewmate, create_task or update_task, a crewmate's file_followup or
// start_program - is refused a title past its room, told the room and the
// title's length, and says it shorter; nothing is saved cut. A title the
// host makes itself from longer words - the captain's first sentence, a
// card's title, a prefix on another task's title, a required action's or a
// program part's label - has no author to refuse, so it ends on its last
// whole word that fits, marked with an ellipsis, never mid-word.

import { cutText } from "./textCut";

/** The room a task title has, counted as every title check counts it, in UTF-16 code units. */
export const TASK_TITLE_MAX = 64;

const ELLIPSIS = "…";

/** Why an author's title is refused: its length past the room, both named; none when it fits. */
export function taskTitleRefusal(title: string): string | undefined {
  const length = title.trim().length;
  if (length <= TASK_TITLE_MAX) return undefined;
  return `The title is ${length} characters, and a task title holds at most ${TASK_TITLE_MAX}: say it in ${TASK_TITLE_MAX} or fewer and call again.`;
}

/**
 * A title the host makes from longer words: one line, whole when it fits,
 * else cut after its last whole word that leaves room for the ellipsis.
 * Only a first word longer than the room is cut inside, as nothing shorter
 * holds any of it.
 */
export function shortTaskTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TASK_TITLE_MAX) return flat;
  const room = TASK_TITLE_MAX - ELLIPSIS.length;
  // A space just past the room means the room ends on a whole word.
  const space = flat.lastIndexOf(" ", room);
  const kept = space > 0 ? flat.slice(0, space) : cutText(flat, room);
  return `${kept.replace(/[\s,;:\-–—]+$/u, "")}${ELLIPSIS}`;
}

/**
 * A title as the record saves it, its last guard: unchanged when it fits,
 * else shortened as the host's own. An author's title past the room was
 * refused before it got here.
 */
export function savedTaskTitle(title: string): string {
  return title.length > TASK_TITLE_MAX ? shortTaskTitle(title) : title;
}
