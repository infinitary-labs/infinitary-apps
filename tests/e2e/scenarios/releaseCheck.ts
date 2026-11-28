import { RELEASE_CHECK_LISTED as LISTED } from "../../../src/core/orchestrator/releaseChecks";
import type { Scenario } from "../mockProvider";
import { calledTool, sinceLastUser } from "../providerRequest";

/**
 * The host's release check (docs/task-record.md, "A release check"): while an
 * issue's waiting task waits for its fix to ship in a release, the host starts
 * one short check in the project, whose scripted crewmate declares the fix's
 * first release, and the waiting task then starts.
 */

/** The fix the waiting task waits on, seeded merged with no first release. */
export const RELEASE_CHECK_FIX = {
  id: "coldfix1",
  title: "Stop the meter idling on a cold start",
};
/** The first release the check's crewmate declares for it. */
export const RELEASE_CHECK_RELEASE = {
  version: "1.4.0",
  url: "https://github.com/octo/meterlab/releases/tag/v1.4.0",
  evidence:
    "The fix's merge commit is an ancestor of v1.4.0's commit, and v1.4.0 was published after the merge.",
};
/** The waiting task's goal, which its brief carries and its scripted crewmate answers. */
export const RELEASE_CHECK_WAITING_GOAL =
  "Thank the reporter of the cold start issue once the fix ships in a release.";
export const RELEASE_CHECK_THANKED = "Thanked the reporter: the fix shipped in 1.4.0.";

/** The check's crewmate: one report declaring the fix's first release, then its closing words. */
export const releaseCheckCrew: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream) return undefined;
    const { user, tail } = sinceLastUser(body);
    if (!user.includes(LISTED)) return undefined;
    if (calledTool(tail, "report")) return { text: "Declared the fix's first release." };
    const key = new RegExp(`- (\\S+) "${RELEASE_CHECK_FIX.title}"`).exec(user)?.[1] ?? "";
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `${key} first shipped in ${RELEASE_CHECK_RELEASE.version}.`,
            summary: `${key} first shipped in ${RELEASE_CHECK_RELEASE.version}.`,
            first_release: { ...RELEASE_CHECK_RELEASE, tasks: [key] },
          },
        },
      ],
    };
  };

/** The waiting task's crewmate, once it starts: one report. */
export const releaseCheckWaitingCrew: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream) return undefined;
    const { user, tail } = sinceLastUser(body);
    if (!user.includes(RELEASE_CHECK_WAITING_GOAL)) return undefined;
    if (calledTool(tail, "report")) return { text: RELEASE_CHECK_THANKED };
    return {
      calls: [
        { name: "report", args: { text: RELEASE_CHECK_THANKED, summary: RELEASE_CHECK_THANKED } },
      ],
    };
  };
