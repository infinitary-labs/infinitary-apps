import { expect, test } from "vitest";
import { type BashOutcome, jobExitWake, SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { JOB_BOUND_MS } from "../../../src/core/orchestrator/idleLadder";
import { checkBackAsk } from "../../../src/core/orchestrator/jobWakes";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { createEventBashTool } from "../../../src/core/pi/bashTool";
import { OPEN_CHANGE_TOOL } from "../../../src/core/pi/forgeTools";
import type { ScenarioAnswer } from "../mockProvider";
import { MOCK_NODE_REPORT_PREFIX, NODE_VERSION_PROMPT_MARKER, nodeVersion } from "./nodeVersion";

/**
 * INF-1529: on a loaded Mac mini, login-search-path's crewmate reported
 * "This Mac's node answers not found.": its `node --version` took 3,004 ms
 * against the shell's 3-second limit, the stand-in read the job's receipt as
 * node's answer and found "not found" in the request's open_change tool, then
 * ignored the job's exit wake that carried the version. Replay that order at
 * the stand-in's own boundary, through the bash tool and the job's exit wake,
 * without starting Electron or waiting on a clock; the journey still owns
 * the login search path itself.
 */

const COMMAND = "node --version";
/** What the planted node printed in the failed run. */
const PRINTED = "v99.0.0-login-path";
const REPORT = `${MOCK_NODE_REPORT_PREFIX} ${PRINTED}.`;

/** The bash tool's answer to the command, in its own words: the output, or a job's receipt. */
async function bashAnswer(outcome: BashOutcome): Promise<string> {
  const tool = createEventBashTool(async () => outcome);
  const context = {} as Parameters<typeof tool.execute>[4];
  const { content } = await tool.execute(
    "bash",
    { command: COMMAND },
    undefined,
    undefined,
    context,
  );
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** A host message to the crewmate, as the journey's Pi seat sends it. */
function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

for (const slow of [false, true]) {
  test(`the node-version crewmate reports node's own answer${slow ? " after its job outlasts the shell and the host asks" : ""}`, async () => {
    const answerer = nodeVersion();
    const messages: Record<string, unknown>[] = [
      userMessage(`commission a crewmate: ${NODE_VERSION_PROMPT_MARKER}`),
    ];
    // The request carries the crewmate's tools, whose words hold "not found".
    const tools = [
      {
        type: "function",
        function: {
          name: OPEN_CHANGE_TOOL.name,
          description: OPEN_CHANGE_TOOL.description,
          parameters: OPEN_CHANGE_TOOL.parameters,
        },
      },
    ];
    expect(JSON.stringify(tools)).toContain("not found");
    const next = (): ScenarioAnswer | undefined => {
      const body = JSON.stringify({ messages, stream: true, tools });
      const lastUser = body.lastIndexOf('"role":"user"');
      return answerer({
        body,
        isFirstmate: false,
        wantsStream: true,
        latestUserTail: body.slice(lastUser),
        hasToolResults: messages.length > 1,
        anthropicMessages: false,
        port: 0,
      });
    };

    expect(next()).toEqual({ calls: [{ name: "bash", args: { command: COMMAND } }] });
    const jobId = "47007624";
    const content = await bashAnswer(
      slow ? { kind: "job", jobId, tail: "" } : { kind: "done", exitCode: 0, output: PRINTED },
    );
    // The chat-completions tool call and result shape this journey's Pi seat sends.
    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_3_1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) },
          },
        ],
      },
      { role: "tool", content, tool_call_id: "call_3_1" },
    );
    if (slow) {
      // The receipt is no answer, and neither is the host's ask while the
      // job runs: each turn ends without words or a report.
      expect(next()).toEqual({ text: "" });
      messages.push(
        { role: "assistant", content: "" },
        userMessage(
          renderWake(
            checkBackAsk({ jobId, command: COMMAND, startedAt: 0 }, SYNC_CAP_MS, JOB_BOUND_MS),
          ),
        ),
      );
      expect(next()).toEqual({ text: "" });
      messages.push(
        { role: "assistant", content: "" },
        userMessage(
          renderWake(
            jobExitWake(
              {
                jobId,
                ownerId: "crewmate",
                command: COMMAND,
                exitCode: 0,
                durationMs: 3_052,
                tail: PRINTED,
              },
              "crewmate",
            ),
          ),
        ),
      );
    }
    expect(next()).toEqual({ calls: [{ name: "report", args: { text: REPORT } }] });
  });
}
