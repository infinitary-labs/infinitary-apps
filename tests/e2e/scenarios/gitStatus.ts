import { browserShellMessages } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";

/**
 * A crewmate on a Mac with no git of its own on the search path (git
 * integration phase 2, app-git e2e): a brief carrying this marker runs
 * `git --version` and `git status` in its working copy, then reports the
 * version and the branch line that came back, verbatim.
 */
export const GIT_STATUS_PROMPT_MARKER = "say which git this project runs";
export const MOCK_GIT_REPORT_PREFIX = "The working copy's git answers";

/** The crewmate asks its working copy's git, then reports what came back. */
export const gitStatus: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // The assignment starts at the brief that asked; Claude's client sends
    // each tool result as the latest user message, and the host's ask while
    // a job runs is one too, so neither is a new assignment (INF-1436).
    const messages = providerMessages(body);
    const assignment = messages.findLastIndex(
      (message) => message.role === "user" && message.text.includes(GIT_STATUS_PROMPT_MARKER),
    );
    if (assignment < 0) return undefined;
    if (latestUserTail.includes(MOCK_GIT_REPORT_PREFIX) || calledTool(body, "report")) {
      return { text: "done" };
    }
    // A git past the Pi shell's limit answers with its job's receipt, and its
    // output comes later as the job's exit wake. The receipt is no answer:
    // end the turn without words while the job runs (INF-1141's rule).
    const { readings, pending } = browserShellMessages(messages);
    if (pending) return { text: "" };
    // Only what came back from the shell, never the request's tools section.
    const result = readings
      .slice(assignment + 1)
      .findLast((message) => message.role === "tool")?.text;
    if (result === undefined) {
      return {
        calls: [
          { name: "bash", args: { command: "git --version && git status --short --branch" } },
        ],
      };
    }
    const version = result.match(/git version \d+\.\d+\.\d+/)?.[0];
    const branch = result.match(/## [^\s"\\]+/)?.[0];
    const answer =
      version && branch
        ? `${version} on ${branch}`
        : (result.match(/command not found|not found/)?.[0] ?? "nothing");
    return { calls: [{ name: "report", args: { text: `${MOCK_GIT_REPORT_PREFIX} ${answer}.` } }] };
  };
