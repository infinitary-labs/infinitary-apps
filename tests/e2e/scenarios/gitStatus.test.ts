import { expect, test } from "vitest";
import { type BashOutcome, jobExitWake, SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { JOB_BOUND_MS } from "../../../src/core/orchestrator/idleLadder";
import { checkBackAsk, renderWake } from "../../../src/core/orchestrator/wakes";
import { createEventBashTool } from "../../../src/core/pi/bashTool";
import { OPEN_CHANGE_TOOL } from "../../../src/core/pi/forgeTools";
import { frameServedInput } from "../../../src/shared/servedFrame";
import type { ScenarioAnswer } from "../mockProvider";
import { GIT_STATUS_PROMPT_MARKER, gitStatus, MOCK_GIT_REPORT_PREFIX } from "./gitStatus";

/**
 * INF-1436: on a loaded Mac lane, app-git's crewmate reported "The working
 * copy's git answers not found.": its git took 8 seconds against the shell's
 * 3-second limit, the stand-in read the job's receipt as git's answer and
 * found "not found" in the request's tools section, then ignored the job's
 * exit wake. Replay that order at the stand-in's own boundary, through the
 * bash tool and the job's exit wake, without starting Electron or waiting on
 * a clock; the journey still owns git itself.
 */

const COMMAND = "git --version && git status --short --branch";
/** What git printed in the failed run's working copy. */
const PRINTED = "git version 2.53.0\n## fm/task-19c96eec";
const REPORT = `${MOCK_GIT_REPORT_PREFIX} git version 2.53.0 on ## fm/task-19c96eec.`;

/** The bash tool's answer to the command, in its own words: the output, or a job's receipt. */
async function bashAnswer(outcome: BashOutcome) {
  const tool = createEventBashTool(async () => outcome);
  const context = {} as Parameters<typeof tool.execute>[4];
  return (await tool.execute("bash", { command: COMMAND }, undefined, undefined, context)).content;
}

/** A served wake, as the host puts it to the crewmate. */
function wakeMessage(body: string) {
  return {
    role: "user",
    content: frameServedInput([{ kind: "wake", origin: "agent", body }]).text,
  };
}

for (const slow of [false, true]) {
  test(`the git-status crewmate reports git's own answer${slow ? " after its job outlasts the shell and the host asks" : ""}`, async () => {
    const answerer = gitStatus();
    const messages: { role: string; content: unknown }[] = [
      { role: "user", content: `commission a crewmate: ${GIT_STATUS_PROMPT_MARKER} in ledger` },
    ];
    // The request carries the crewmate's tools, whose words hold "not found".
    const tools = [
      {
        name: OPEN_CHANGE_TOOL.name,
        description: OPEN_CHANGE_TOOL.description,
        input_schema: OPEN_CHANGE_TOOL.parameters,
      },
    ];
    expect(JSON.stringify(tools)).toContain("not found");
    const next = (): ScenarioAnswer | undefined => {
      const body = JSON.stringify({ messages, tools });
      const lastUser = body.lastIndexOf('"role":"user"');
      return answerer({
        body,
        isFirstmate: false,
        wantsStream: true,
        latestUserTail: body.slice(lastUser),
        hasToolResults: messages.length > 1,
        anthropicMessages: true,
        port: 0,
      });
    };

    const ask = next();
    expect(ask).toEqual({ calls: [{ name: "bash", args: { command: COMMAND } }] });
    const jobId = "4737dc96";
    const content = await bashAnswer(
      slow ? { kind: "job", jobId, tail: "" } : { kind: "done", exitCode: 0, output: PRINTED },
    );
    // Anthropic's tool-use/result shape, as the journey's Pi seat sends it.
    messages.push(
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-0", name: "bash", input: { command: COMMAND } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-0", content }] },
    );
    if (slow) {
      // The receipt is no answer, and neither is the host's ask while the
      // job runs: each turn ends without words or a report.
      expect(next()).toEqual({ text: "" });
      messages.push(
        wakeMessage(
          renderWake(
            checkBackAsk({ jobId, command: COMMAND, startedAt: 0 }, SYNC_CAP_MS, JOB_BOUND_MS),
          ),
        ),
      );
      expect(next()).toEqual({ text: "" });
      messages.push(
        wakeMessage(
          renderWake(
            jobExitWake(
              {
                jobId,
                ownerId: "crewmate",
                command: COMMAND,
                exitCode: 0,
                durationMs: 8000,
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
