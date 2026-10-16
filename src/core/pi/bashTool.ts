import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { BashOutcome } from "../jobs/jobManager";

/**
 * The event-driven bash tool (R2): Infinitary-owned, replacing blocking bash.
 * A command that finishes within the 3-second cap returns its output like
 * ordinary bash; anything longer continues as a background job whose EXIT
 * wakes the owning session - the Firstmate agent through the durable inbox,
 * a Pi crewmate as its next turn. Nothing polls, and no tool call can hold
 * the agent away from the user (the captain's round-2 requirement).
 *
 * Confinement is deliberately Pi-native (captain decision): the command
 * runs from the session's own working directory with no jail or sandbox;
 * the system prompt steers use, the tool does not.
 */

const BASH_PARAMETERS = Type.Object({
  command: Type.String({ description: "The command, run with bash -c" }),
  background: Type.Optional(Type.Boolean({ description: "Start as a background job immediately" })),
  // The line the task's record shows for this call (docs/task-record.md,
  // "A crewmate's actions"); the command does not read it.
  description: Type.Optional(
    Type.String({
      description:
        'What the command does, in one short line of plain words in the active voice, such as "Run the unit tests". The task\'s record shows it to the captain.',
    }),
  ),
});

/** The arguments the crewmate's bash takes in place of Pi's own. */
export type EventBashInput = Static<typeof BASH_PARAMETERS>;

export type BashRunner = (input: EventBashInput) => Promise<BashOutcome>;

export function createEventBashTool(runner: BashRunner): ToolDefinition {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: [
      "Run a shell command. Finishes within 3 seconds: you get the output now.",
      "Longer: it continues as a background job and its result reaches you as a",
      "later message when the process exits - so end your turn instead of",
      "waiting. Pass background true for known-long commands (builds, test",
      "suites, watchers); a blocking waiter is a fine way to be woken by an",
      "outside event.",
    ].join(" "),
    parameters: BASH_PARAMETERS,
    execute: async (_toolCallId, params) => {
      const outcome = await runner({
        command: params.command,
        ...(params.background !== undefined ? { background: params.background } : {}),
      });
      if (outcome.kind === "done") {
        return {
          content: [
            {
              type: "text",
              text: `exit ${outcome.exitCode ?? "by signal"}\n${outcome.output || "(no output)"}`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Still running as background job ${outcome.jobId}; you will receive the result when it exits.${
              outcome.tail ? ` Output so far:\n${outcome.tail}` : ""
            }`,
          },
        ],
        details: {},
      };
    },
  }) as ToolDefinition;
}
