import { expect, test } from "vitest";
import { renderIntegrationReply } from "../../../src/core/axi/integrationCommands";
import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { frameServedInput } from "../../../src/shared/servedFrame";
import { SAMPLE_NOTES } from "../../helpers/mcpStandIn";
import type { ScenarioAnswer } from "../mockProvider";
import { MCP_NOTES_PROMPT_MARKER, MCP_NOTES_REPORT_PREFIX, mcpNotes } from "./mcpNotes";

/**
 * INF-1124: replay the two real slow replies from the failed main/alpha runs
 * at the stand-in's own boundary, without starting Electron or waiting on a
 * clock. The existing journey still owns the actual Notes interaction.
 */
for (const slow of ["shell job", "kept integration answer"] as const) {
  test(`the Notes stand-in follows a ${slow} without repeating the call`, () => {
    const answerer = mcpNotes();
    const messages: { role: string; content: unknown }[] = [
      { role: "user", content: MCP_NOTES_PROMPT_MARKER },
    ];
    let last: ScenarioAnswer | undefined;
    const commands: string[] = [];
    const next = () => {
      const body = JSON.stringify({ messages });
      last = answerer({
        body,
        isFirstmate: false,
        wantsStream: true,
        latestUserTail: body,
        hasToolResults: messages.length > 1,
      });
      return last;
    };
    // Anthropic's tool-use/result shape, as the journey's Pi seat sends it.
    const result = (text: string) => {
      if (!last || !("calls" in last)) throw new Error("Expected a tool call");
      expect(last.calls).toHaveLength(1);
      const call = last.calls[0];
      if (!call) throw new Error("Missing tool call");
      if (call.name === "bash") commands.push(call.args.command);
      const id = `tool-${messages.length}`;
      messages.push(
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name: call.name, input: call.args }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
      );
    };
    const wake = (text: string) => {
      messages.push({
        role: "user",
        content: frameServedInput([{ kind: "wake", origin: "agent", body: text }]).text,
      });
    };
    const notes = SAMPLE_NOTES.map((note, index) => `${index + 1}. ${note}`).join("\n");
    const readAgain = { calls: [{ name: "bash", args: { command: INTEGRATIONS_COMMAND } }] };
    expect(next()).toMatchObject({ calls: [{ name: "bash" }] });
    if (slow === "kept integration answer") {
      result(`exit 0\n${renderIntegrationReply("call", { kind: "running", command: "call" }, [])}`);
      expect(next()).toEqual(readAgain);
      result(
        "exit 1\nerror: Your earlier call is still running, so this command was not run\ncode: BUSY\n",
      );
      expect(next()).toEqual(readAgain);
    }
    // The original command, or the bare command reading its kept answer,
    // may itself become a job. Neither receipt is the Notes server's reply.
    result("Still running as background job d869b7d0; you will receive the result when it exits.");
    expect(next()).toEqual({ text: "The integrations command is still running." });
    wake(
      renderWake({
        facts: {
          kind: "job-exit",
          to: "crewmate",
          jobId: "d869b7d0",
          command: commands.at(-1) ?? "",
          exitCode: 0,
          durationMs: SYNC_CAP_MS + 1000,
          tail:
            slow === "shell job"
              ? notes
              : renderIntegrationReply(
                  "integrations",
                  { kind: "earlier", command: "call", answer: { text: notes } },
                  [],
                ),
        },
      }),
    );
    expect(next()).toMatchObject({
      calls: [
        {
          name: "report",
          args: {
            text: expect.stringContaining(MCP_NOTES_REPORT_PREFIX),
          },
        },
      ],
    });
    if (!last || !("calls" in last) || last.calls[0]?.name !== "report")
      throw new Error("Expected the Notes report");
    expect(last.calls[0].args.text).toContain(notes);
    expect(
      commands.filter((command) => command.startsWith(`${INTEGRATIONS_COMMAND} call `)),
    ).toHaveLength(1);
    expect(commands.slice(1)).toEqual(
      slow === "shell job" ? [] : [INTEGRATIONS_COMMAND, INTEGRATIONS_COMMAND],
    );
    result("Reported.");
    expect(next()).toEqual({ text: "Waiting for the captain." });
  });
}
