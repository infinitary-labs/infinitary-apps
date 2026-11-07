import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { WRITE_ANSWERED_LEAD } from "../../../src/core/orchestrator/deliveryWakes";
import { browserShellMessages } from "../browserScript";
import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { calledTool, providerMessages, sinceLastUser } from "../providerRequest";

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
    // INF-1124: a shell exit is a new turn, not permission to call Notes again.
    if (!calledTool(body, "bash")) {
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
    // The shell can return its job receipt before the command reaches the app.
    // Resume from the exit wake, through the same reader the browser uses.
    const shell = browserShellMessages(providerMessages(body));
    if (shell.pending) return { text: "The integrations command is still running." };
    const answer = shell.readings.findLast((message) => message.role === "tool")?.text ?? "";
    // The command can also finish before the integration does. Read its kept
    // answer with the bare command, including after BUSY, never another call.
    if (/^running: /m.test(answer) || /^code: BUSY$/m.test(answer))
      return { calls: [{ name: "bash", args: { command: INTEGRATIONS_COMMAND } }] };
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

/**
 * The first mate calls the Notes server itself (INF-1108): a captain message
 * carrying this marker has it call `use_integration` with its reason, and the
 * app's own card holds the call. The journey passes a `seen` box, where the
 * first mate's `write-answered` wakes land for it to read.
 */
// e2e-typed-words: the captain's own words that start the first mate's call; they only share a phrase with the product's
export const MCP_NOTES_FIRSTMATE_MARKER = "keep my plant reminder in the Notes server yourself";
export const MCP_NOTES_FIRSTMATE_REASON = "You asked me to keep this reminder in your notes.";
export const MCP_NOTES_FIRSTMATE_REMINDER = "Water the plants on Sunday";
export type McpNotesFirstmateSeen = { wakes: string[] };

export function mcpNotesFirstmate(seen: McpNotesFirstmateSeen): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) => {
      if (!isFirstmate || !wantsStream) return undefined;
      const current = sinceLastUser(body);
      if (current.user.includes(WRITE_ANSWERED_LEAD) && current.user.includes("add_note")) {
        if (current.results.length === 0) seen.wakes.push(current.user);
        return { text: "Your reminder is in your notes." };
      }
      if (!current.user.includes(MCP_NOTES_FIRSTMATE_MARKER)) return undefined;
      if (current.results.length > 0) return { text: "The app is asking you on its card." };
      return {
        calls: [
          {
            name: "use_integration",
            args: {
              name: MCP_NOTES_NAME,
              action: "add_note",
              input: { text: MCP_NOTES_FIRSTMATE_REMINDER },
              reason: MCP_NOTES_FIRSTMATE_REASON,
            },
          },
        ],
      };
    };
}

/**
 * A crewmate adds two reminders through the Notes server (INF-2993): a brief
 * carrying this marker calls `add_note` for the first, waits on the approval
 * card like the change above, and once it hears the captain's answer calls
 * `add_note` again for the second, then reports what the server answered.
 * The second call runs without a card only when the captain chose Allow for
 * the rest of this task; otherwise the crewmate reports the second card.
 */
export const MCP_NOTES_TWICE_MARKER = "add both my reminders through the Notes server";
export const MCP_NOTES_SECOND_REMINDER = "Renew the parking permit before the 15th";

export const mcpNotesTwice: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(MCP_NOTES_TWICE_MARKER)) return undefined;
    const current = sinceLastUser(body);
    if (calledTool(current.tail, "report")) return { text: "Waiting for the captain." };
    const addNote = (text: string): ScenarioAnswer => ({
      calls: [
        {
          name: "bash",
          args: {
            command: `${INTEGRATIONS_COMMAND} call ${MCP_NOTES_NAME} add_note '${JSON.stringify({ text })}' --reason '${MCP_NOTES_REASON}'`,
          },
        },
      ],
    });
    if (current.user.includes(WRITE_ANSWERED_LEAD) && !calledTool(current.tail, "bash"))
      return addNote(MCP_NOTES_SECOND_REMINDER);
    if (!calledTool(body, "bash")) return addNote(MCP_NOTES_REMINDER);
    // The same reading of the shell as the change above, for whichever call came last.
    const shell = browserShellMessages(providerMessages(body));
    if (shell.pending) return { text: "The integrations command is still running." };
    const answer = shell.readings.findLast((message) => message.role === "tool")?.text ?? "";
    if (/^running: /m.test(answer) || /^code: BUSY$/m.test(answer))
      return { calls: [{ name: "bash", args: { command: INTEGRATIONS_COMMAND } }] };
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
