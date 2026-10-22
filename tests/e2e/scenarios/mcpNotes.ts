import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { calledTool, type Scenario, sinceLastUser } from "../mockProvider";

/**
 * A crewmate reads the captain's notes through an MCP server he added
 * (INF-781; `integrations-mcp.spec.ts`): a brief carrying this marker runs
 * the integrations command in its own shell, calling the server's
 * `list_notes`, and reports what it answered after this prefix.
 */
export const MCP_NOTES_PROMPT_MARKER = "read my notes through the Notes server";
export const MCP_NOTES_REPORT_PREFIX = "The Notes server answered: ";
/** The integration's name as the captain wrote it in Settings, and the action the crewmate calls. */
export const MCP_NOTES_NAME = "Notes";
export const MCP_NOTES_ACTION = "list_notes";

export const mcpNotes: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(MCP_NOTES_PROMPT_MARKER)) return undefined;
    if (calledTool(body, "report")) return { text: "done" };
    if (!calledTool(body, "bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: `${INTEGRATIONS_COMMAND} call ${MCP_NOTES_NAME} ${MCP_NOTES_ACTION} '{}'`,
            },
          },
        ],
      };
    const answer = sinceLastUser(body).results.at(-1) ?? "";
    return {
      calls: [{ name: "report", args: { text: `${MCP_NOTES_REPORT_PREFIX}${answer}` } }],
    };
  };
