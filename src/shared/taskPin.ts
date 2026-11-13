/**
 * Pinning a task (INF-3127, the captain's words: "when a task is pinned, it
 * always show in a 'pinned' section in the tasks panel at the top, no matter
 * what state it's in"): the pin is a dated fact on the task's own record,
 * written by `TaskService.setPinned`. These are its words, read by the
 * Tasks panel's row button, the task board's tile menu and the task
 * record, and by the record's timeline.
 */

import * as m from "./i18n/messages.generated.ts";
import { BOARD_RECENT_MS } from "./tasks";

/** Pin and Unpin in the process's language: the board menu's and the row's own words, and the phone's. */
export const PIN_WORDS = {
  get pin() {
    return m.taskPinPin();
  },
  get unpin() {
    return m.taskPinUnpin();
  },
};
/** The source language's words as the module loads, for a test that names them. */
export const PIN_LABEL = m.taskPinPin();
/** What the filled pin beside a pinned task's key in a crewmate's summary says to a screen reader (INF-3634). */
export const PINNED_MARK_LABEL = "Pinned";
export const UNPIN_LABEL = m.taskPinUnpin();

/** What a pin control is called: Pin INF-402 on a task that is not pinned, Unpin INF-402 on one that is. */
export function pinActionLabel(pinned: boolean, key: string): string {
  return `${pinned ? PIN_WORDS.unpin : PIN_WORDS.pin} ${key}`.trim();
}

/** The record's Activity line for a pin or an unpin. */
export function pinActivity(actor: "captain" | "firstmate", pinned: boolean): string {
  const who = actor === "captain" ? "You" : "Your first mate";
  return pinned
    ? `${who} pinned this task to the top of Tasks.`
    : `${who} unpinned this task from the top of Tasks.`;
}

/** Why a pin wrote nothing: the task is not here. */
export function pinMissingRefusal(id: string): string {
  return `Cannot pin ${id}: that task is not here.`;
}

/**
 * Whether a pinned task is on the board only because it is pinned: it
 * closed before the board's seven days. It lists in Pinned and in no
 * board lane - not in a done or dropped 7d list or count - and pulls no
 * old closed parent onto the board with it; the board's Find still lists
 * it under Earlier matches when it is done (INF-3127). `at` is when the
 * board was read.
 */
export function pinnedPastWeek(
  task: { pinnedAt?: number | null | undefined; status: string; closedAt: number | null },
  at: number,
): boolean {
  return (
    task.pinnedAt != null &&
    (task.status === "done" || task.status === "dropped") &&
    (task.closedAt ?? 0) < at - BOARD_RECENT_MS
  );
}
