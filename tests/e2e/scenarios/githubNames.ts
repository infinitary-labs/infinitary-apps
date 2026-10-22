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
    if (!calledTool(body, "bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: [
                INTEGRATIONS_COMMAND,
                `${INTEGRATIONS_COMMAND} call GitHub read '{"path":"/user"}'`,
                `${INTEGRATIONS_COMMAND} call '${GITHUB_SERVER_NAME}' list_notes '{}'`,
              ].join(" && "),
            },
          },
        ],
      };
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `${GITHUB_NAMES_REPORT}${sinceLastUser(body).results.at(-1) ?? ""}`,
          },
        },
      ],
    };
  };
