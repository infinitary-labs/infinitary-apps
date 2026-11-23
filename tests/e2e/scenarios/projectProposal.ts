import type { Scenario } from "../mockProvider";

/**
 * A project proposed after a crewmate's report (the setup card, docs/fleet.md
 * "Asking the first mate to add a project"): a crewmate briefed with "report that
 * the runner fixes need the folder at <path>" ends its turn with a report
 * saying that folder must be set up as a project first, which reaches the
 * Firstmate as an [fm-op]; the mock Firstmate then proposes it with
 * app_change project-setup, naming the work it starts once it is added.
 */
export const PROPOSE_PROJECT_PROMPT_MARKER = "report that the runner fixes need the folder at ";
const PROPOSE_PROJECT_REPORT_NEEDLE = "set up as a project first";
export const MOCK_PROPOSED_WORK = "open the pull request for the runner fixes";

export const projectProposal: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream || hasToolResults) return undefined;
    if (isFirstmate && latestUserTail.includes(PROPOSE_PROJECT_REPORT_NEEDLE)) {
      const path = latestUserTail.match(
        new RegExp(`folder at (\\S+) ${PROPOSE_PROJECT_REPORT_NEEDLE}`),
      )?.[1] as string;
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "project-setup",
              value: { kind: "adopt", path, work: MOCK_PROPOSED_WORK },
              evidence: "the crewmate reported the runner fixes need this project",
            },
          },
        ],
      };
    }
    if (!isFirstmate && latestUserTail.includes(PROPOSE_PROJECT_PROMPT_MARKER)) {
      const path = latestUserTail.match(
        new RegExp(`${PROPOSE_PROJECT_PROMPT_MARKER}([^"\\\\\\s]+)`),
      )?.[1];
      return {
        text: `The runner fixes need the folder at ${path} ${PROPOSE_PROJECT_REPORT_NEEDLE}.`,
      };
    }
    return undefined;
  };
