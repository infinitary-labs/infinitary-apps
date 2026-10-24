import { calledTool, type Scenario } from "../mockProvider";

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
  ({ body, isFirstmate, anthropicMessages, wantsStream, latestUserTail, hasToolResults }) => {
    // Claude's client sends each tool result as the latest user message,
    // so on its wire the marker is earlier in the conversation.
    const asked =
      latestUserTail.includes(GIT_STATUS_PROMPT_MARKER) ||
      (anthropicMessages && body.includes(GIT_STATUS_PROMPT_MARKER));
    if (isFirstmate || !asked || !wantsStream) return undefined;
    if (!hasToolResults) {
      return {
        calls: [
          { name: "bash", args: { command: "git --version && git status --short --branch" } },
        ],
      };
    }
    if (latestUserTail.includes(MOCK_GIT_REPORT_PREFIX) || calledTool(body, "report")) {
      return { text: "done" };
    }
    // Only what came back from the shell: the tool result follows the
    // call, or is the latest user message itself on Claude's wire.
    const call = latestUserTail.indexOf('"tool_calls"');
    const result = call >= 0 ? latestUserTail.slice(call) : latestUserTail;
    const version = result.match(/git version \d+\.\d+\.\d+/)?.[0];
    const branch = result.match(/## [^\s"\\]+/)?.[0];
    const answer =
      version && branch
        ? `${version} on ${branch}`
        : (result.match(/command not found|not found/)?.[0] ?? "nothing");
    return { calls: [{ name: "report", args: { text: `${MOCK_GIT_REPORT_PREFIX} ${answer}.` } }] };
  };
