import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { INTEGRATION_KIND_NAMES } from "../../../src/shared/integrations";
import { browserShellMessages } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";

/** INF-882: a crew read by each distinct name must reach its original connection. */
export const GITHUB_NAMES_PROMPT = "read my GitHub account and my renamed server";
export const GITHUB_NAMES_REPORT = "Both connections answered: ";
export const GITHUB_SERVER_NAME = `${INTEGRATION_KIND_NAMES.github} ${INTEGRATION_KIND_NAMES.mcp}`;

export const githubNames: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(GITHUB_NAMES_PROMPT)) return undefined;
    if (calledTool(body, "report")) return { text: "done" };
    // A read past the Pi shell's limit answers with its job's receipt, and its
    // answer comes later as the job's exit wake. Read through the shell reader
    // the browser uses: the receipt is no answer, and the exit wake is the
    // read's answer, never a new assignment (INF-1141). While the job runs,
    // end the turn without words: its exit wake is the next turn, and words
    // now would be one more report on the task.
    const { readings, pending: running } = browserShellMessages(providerMessages(body));
    if (running) return { text: "" };
    // The assignment starts at the commission that asked for these reads. A
    // later user message - the host's nudge while a job runs, say - is no new
    // assignment: the results before it are still this one's (INF-1436).
    const assignment = readings.findLastIndex(
      (message) => message.role === "user" && message.text.includes(GITHUB_NAMES_PROMPT),
    );
    const results = readings
      .slice(assignment + 1)
      .flatMap((message) => (message.role === "tool" ? [message.text] : []));
    const reads = [
      INTEGRATIONS_COMMAND,
      `${INTEGRATIONS_COMMAND} call GitHub read '{"path":"/user"}'`,
      `${INTEGRATIONS_COMMAND} call '${GITHUB_SERVER_NAME}' list_notes '{}'`,
    ];
    // One read per shell, so each has its shell's whole limit. A call can still
    // outlast it and return its kept-work receipt rather than its answer, and the
    // home command that collects it can find it still running (BUSY), which runs
    // nothing. Collect it with the home command until it answers; never repeat
    // the call or report its receipt as data (INF-963).
    const pending = (result: string) => /^running: |^code: BUSY$/m.test(result);
    const completed = results.filter((result) => !pending(result)).length;
    const next = reads[completed];
    if (next)
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: pending(results.at(-1) ?? "") ? INTEGRATIONS_COMMAND : next,
            },
          },
        ],
      };
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `${GITHUB_NAMES_REPORT}${results.join("\n")}`,
          },
        },
      ],
    };
  };
