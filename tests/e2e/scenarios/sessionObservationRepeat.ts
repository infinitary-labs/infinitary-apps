import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

export const SESSION_REPEAT_MARKER = "Repeat the saved session observation check.";
export const SESSION_REPEAT_REPORT = "The second status note is ready.";

/** INF-1484 E2: a real second crewmate turn rereads the same opaque binding and facts. */
export const sessionObservationRepeat: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream) return undefined;
    const turn = sinceLastUser(body);
    if (!turn.user.includes(SESSION_REPEAT_MARKER)) return undefined;
    return turn.results.length === 0
      ? { calls: [{ name: "report", args: { text: SESSION_REPEAT_REPORT } }] }
      : { text: SESSION_REPEAT_REPORT };
  };
