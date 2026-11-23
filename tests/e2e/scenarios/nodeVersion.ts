import { browserShellMessages } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";

/**
 * A crewmate on a Mac opened from the Dock (host-env e2e): a brief carrying
 * this marker runs `node --version` in its shell, then reports what came
 * back, verbatim, so the spec reads the answer off the feed.
 */
export const NODE_VERSION_PROMPT_MARKER = "say which node this Mac runs";

export const MOCK_NODE_REPORT_PREFIX = "This Mac's node answers";

export const nodeVersion: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // The assignment starts at the brief that asked; the host's ask while a
    // job runs and the job's exit wake are later user messages, never a new
    // assignment (INF-1436).
    const messages = providerMessages(body);
    const assignment = messages.findLastIndex(
      (message) => message.role === "user" && message.text.includes(NODE_VERSION_PROMPT_MARKER),
    );
    if (assignment < 0) return undefined;
    if (latestUserTail.includes(MOCK_NODE_REPORT_PREFIX) || calledTool(body, "report")) {
      return { text: "done" };
    }
    // A node past the Pi shell's limit answers with its job's receipt, and its
    // output comes later as the job's exit wake. The receipt is no answer:
    // end the turn without words while the job runs (INF-1141's rule, INF-1529).
    const { readings, pending } = browserShellMessages(messages);
    if (pending) return { text: "" };
    // Only what came back from the shell, never the request's tools section.
    const result = readings
      .slice(assignment + 1)
      .findLast((message) => message.role === "tool")?.text;
    if (result === undefined) {
      return { calls: [{ name: "bash", args: { command: "node --version" } }] };
    }
    const answer =
      result.match(/v\d+\.\d+\.\d+[\w.-]*/)?.[0] ??
      result.match(/command not found|not found/)?.[0] ??
      "nothing";
    return {
      calls: [{ name: "report", args: { text: `${MOCK_NODE_REPORT_PREFIX} ${answer}.` } }],
    };
  };
