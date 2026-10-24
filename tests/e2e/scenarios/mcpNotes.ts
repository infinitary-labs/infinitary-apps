import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { WRITE_ANSWERED_LEAD } from "../../../src/core/orchestrator/wakes";
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
export const MCP_NOTES_REASON = "Find the reminders you asked me to summarize.";
export const MCP_NOTES_CHANGE_MARKER = "add my reminder through the Notes server";
export const MCP_NOTES_REMINDER = "Return the library books by Friday";

export const mcpNotes: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (
      isFirstmate ||
      !wantsStream ||
      !(body.includes(MCP_NOTES_PROMPT_MARKER) || body.includes(MCP_NOTES_CHANGE_MARKER))
    )
      return undefined;
    const current = sinceLastUser(body);
    if (calledTool(current.tail, "report")) return { text: "Waiting for the captain." };
    if (
      current.user.includes(WRITE_ANSWERED_LEAD) ||
      current.user.startsWith("[fm-op] the captain's click on ask")
    )
      return {
        calls: [{ name: "report", args: { text: `${MCP_NOTES_REPORT_PREFIX}${current.user}` } }],
      };
    if (!calledTool(current.tail, "bash")) {
      const change = body.includes(MCP_NOTES_CHANGE_MARKER);
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: `${INTEGRATIONS_COMMAND} call ${MCP_NOTES_NAME} ${change ? "add_note" : MCP_NOTES_ACTION} '${JSON.stringify(change ? { text: MCP_NOTES_REMINDER } : {})}' --reason '${MCP_NOTES_REASON}'`,
            },
          },
        ],
      };
    }
    const answer = current.results.at(-1) ?? "";
    const ask = /approval card for ask (ia[a-f0-9]+)/.exec(answer)?.[1];
    if (ask)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: "The app is asking for this action.",
              summary: "The app is asking for this action.",
              waiting_on_captain: {
                reason: "Choose whether the action may run",
                card_id: `integration-ask-${ask}`,
              },
            },
          },
        ],
      };
    return { calls: [{ name: "report", args: { text: `${MCP_NOTES_REPORT_PREFIX}${answer}` } }] };
  };
