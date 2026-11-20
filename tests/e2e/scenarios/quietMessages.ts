import type { Scenario } from "../mockProvider";

export const QUIET_WORK_MARKER = "keep working while my earlier clue becomes second-to-last";

/** INF-1969: the newest model request stays open across the older round's reading clock. */
export const quietMessages: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail }) =>
    isFirstmate && wantsStream && latestUserTail.includes(QUIET_WORK_MARKER)
      ? { held: true }
      : undefined;
