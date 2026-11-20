import { updateResumedWords } from "@shared/updateWords";
import type { Scenario } from "../mockProvider";
import { providerMessages } from "../providerRequest";

/**
 * A crewmate whose turn is still running when this computer's copy updates
 * (docs/alpha.md, "Saving work before an update"): its model is still
 * working - the stand-in holds the turn open - until the new copy carries
 * the turn on, saying an update stopped it; then it reports.
 */
export const UPDATE_RESUME_MARKER = "keep working through an update";

export const MOCK_UPDATE_RESUME_REPORT =
  "I picked the work up again after the update and checked what had already happened first.";

/**
 * Held open while the crewmate's conversation has no turn an update stopped;
 * once one carries it on, it reports.
 */
export const updateResume: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, hasToolResults }) => {
    if (isFirstmate || !wantsStream || !body.includes(UPDATE_RESUME_MARKER)) return undefined;
    if (hasToolResults) return { text: "Reported." };
    const resumed = providerMessages(body).some(
      (message) => message.role === "user" && message.text.includes(updateResumedWords()),
    );
    return resumed
      ? { calls: [{ name: "report", args: { text: MOCK_UPDATE_RESUME_REPORT } }] }
      : { held: true };
  };
