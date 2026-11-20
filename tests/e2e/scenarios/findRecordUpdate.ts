import type { Scenario } from "../mockProvider";

/**
 * Find in this card on a task's record (docs/keyboard.md, "Finding in the
 * shown card"): the captain's words ask the first mate to record a verdict
 * on the task they name, which updates the shown record in place.
 */
export const FIND_RECORD_UPDATE_MARKER = "record the keyboard verdict on";
/** The verdict the first mate records, with one more of the words looked for. */
export const FIND_RECORD_VERDICT = "The keyboard map is settled.";

export const findRecordUpdate: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || !latestUserTail.includes(FIND_RECORD_UPDATE_MARKER))
      return undefined;
    if (hasToolResults) return { text: "Recorded the verdict." };
    const task = /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(latestUserTail)?.[1] ?? "missing";
    return { calls: [{ name: "update_task", args: { task, verdict: FIND_RECORD_VERDICT } }] };
  };
