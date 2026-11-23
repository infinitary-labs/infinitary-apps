import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * Hermetic replay for INF-775 piece 3, not a claim that a live model obeys:
 * an Automation rule fires on the stand-in integration's events, and the
 * first mate's turn reads them. The scripted first mate answers each such
 * turn in a line and keeps the prompt it was served in `seen`, for the
 * journey to read what one turn carried.
 */
export type AutomationEventsSeen = { turns: string[] };

export const AUTOMATION_EVENTS_ANSWER = "Triaged the new items.";

/** The words a served event rule's prompt opens with (`renderWake`, docs/automation.md "Events"). */
const EVENT_RUN = /\[fm-op\] scheduled by automation \S+ "[^"]*" on \d+ new event/;

export function automationEvents(seen: AutomationEventsSeen): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) => {
      if (!wantsStream || !isFirstmate) return undefined;
      const { user, results } = sinceLastUser(body);
      if (!EVENT_RUN.test(user) || results.length > 0) return undefined;
      seen.turns.push(user);
      return { text: AUTOMATION_EVENTS_ANSWER };
    };
}
