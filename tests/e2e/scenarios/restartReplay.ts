import { RESTART_REPLAY_NOTE } from "../../../src/core/orchestrator/wakes";
import type { Scenario } from "../mockProvider";
import { providerMessages } from "../providerRequest";

/**
 * A crewmate whose one long turn the app closes under, again and again
 * (quit-mid-turn.spec.ts; docs/inbox.md, "A turn a quit or crash cut"). Its
 * turn is held open - the model still working - each time its message
 * arrives, until that message has come back after RESTART_REPLAY_QUITS
 * restarts, each one saying so; then it reports.
 */
export const RESTART_REPLAY_PROMPT_MARKER = "keep working through restarts";

export const RESTART_REPLAY_QUITS = 3;

export const MOCK_RESTART_REPLAY_REPORT =
  "I picked the work up again after three restarts and checked what had already happened first.";

export const restartReplay: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (!isFirstmate && body.includes(RESTART_REPLAY_PROMPT_MARKER) && wantsStream) {
      if (hasToolResults) {
        return { text: "Reported." };
      }
      const replays = providerMessages(body).filter(
        (message) => message.role === "user" && message.text.includes(RESTART_REPLAY_NOTE),
      ).length;
      if (replays < RESTART_REPLAY_QUITS) {
        return { held: true };
      }
      return { calls: [{ name: "report", args: { text: MOCK_RESTART_REPLAY_REPORT } }] };
    }
    return undefined;
  };
