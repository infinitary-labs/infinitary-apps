import type { Scenario } from "../mockProvider";

/**
 * A crewmate on a Mac opened from the Dock (host-env e2e): a brief carrying
 * this marker runs `node --version` in its shell, then reports what came
 * back, verbatim, so the spec reads the answer off the feed.
 */
export const NODE_VERSION_PROMPT_MARKER = "say which node this Mac runs";

export const MOCK_NODE_REPORT_PREFIX = "This Mac's node answers";

/** The crewmate runs node from the login search path and reports its version. */
export const nodeVersion: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (!isFirstmate && latestUserTail.includes(NODE_VERSION_PROMPT_MARKER) && wantsStream) {
      if (!hasToolResults) {
        return { calls: [{ name: "bash", args: { command: "node --version" } }] };
      }
      if (latestUserTail.includes(MOCK_NODE_REPORT_PREFIX)) {
        return { text: "done" };
      }
      // Only what came back from the shell: the tool result follows the call.
      const result = latestUserTail.slice(latestUserTail.indexOf('"tool_calls"'));
      const answer =
        result.match(/v\d+\.\d+\.\d+[\w.-]*/)?.[0] ??
        result.match(/command not found|not found/)?.[0] ??
        "nothing";
      return {
        calls: [{ name: "report", args: { text: `${MOCK_NODE_REPORT_PREFIX} ${answer}.` } }],
      };
    }
    return undefined;
  };
