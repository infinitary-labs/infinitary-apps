import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { INTEGRATION_KIND_NAMES } from "../../../src/shared/integrations";
import { calledTool, type Scenario, sinceLastUser } from "../mockProvider";

/** INF-882: a crew read by each distinct name must reach its original connection. */
export const GITHUB_NAMES_PROMPT = "read my GitHub account and my renamed server";
export const GITHUB_NAMES_REPORT = "Both connections answered: ";
export const GITHUB_SERVER_NAME = `${INTEGRATION_KIND_NAMES.github} ${INTEGRATION_KIND_NAMES.mcp}`;

export const githubNames: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(GITHUB_NAMES_PROMPT)) return undefined;
    if (calledTool(body, "report")) return { text: "done" };
    const results = sinceLastUser(body).results;
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
