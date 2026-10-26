import { expect, test } from "vitest";
import { renderIntegrationReply } from "../../../src/core/axi/integrationCommands";
import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { type BashOutcome, jobExitWake, SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { JOB_BOUND_MS } from "../../../src/core/orchestrator/idleLadder";
import { checkBackAsk, renderWake } from "../../../src/core/orchestrator/wakes";
import { createEventBashTool } from "../../../src/core/pi/bashTool";
import { frameServedInput } from "../../../src/shared/servedFrame";
import { SAMPLE_NOTES } from "../../helpers/mcpStandIn";
import { STUB_LOGIN } from "../githubStub";
import type { ScenarioAnswer } from "../mockProvider";
import {
  GITHUB_NAMES_PROMPT,
  GITHUB_NAMES_REPORT,
  GITHUB_SERVER_NAME,
  githubNames,
} from "./githubNames";

/**
 * INF-1141: on a loaded Mac lane, older-profile's GitHub-names journey got
 * the report "Both connections answered: Still running as background job
 * 3ccb3f71; ...": the integrations list outlasted the shell's 3-second
 * limit, and the stand-in took its job's receipt for the list. Replay a
 * slow read at each place at the stand-in's own boundary, through the bash
 * tool and the job's exit wake, without starting Electron or waiting on a
 * clock; the journey still owns the reads themselves.
 */

/** What each read printed, as the journey's integrations answered them on the Mac lane. */
const LISTED = renderIntegrationReply(
  "integrations",
  {
    kind: "answer",
    answer: {
      data: {
        integrations: [
          {
            name: "GitHub",
            id: "github",
            connection: "c-96dd4c48-d04d-45a3-b428-3456e057849c",
            kind: "github",
            account: STUB_LOGIN,
            health: "ok",
            actions: [
              { name: "read", rule: "allow" },
              { name: "write", rule: "ask" },
            ],
          },
          {
            name: GITHUB_SERVER_NAME,
            id: "mcp-github",
            connection: "c-a13fcf0f-130f-4b9f-8f33-d0b169f13dba",
            kind: "mcp",
            renamed: { from: "GitHub", for: "GitHub" },
            health: "ok",
            actions: [
              { name: "list_notes", rule: "allow" },
              { name: "get_note", rule: "ask" },
              { name: "add_note", rule: "ask" },
              { name: "read_resource", rule: "ask" },
            ],
            events: ["resource_changed"],
          },
        ],
      },
    },
  },
  [],
);
const GITHUB_ACCOUNT = renderIntegrationReply(
  "call",
  {
    kind: "answer",
    answer: {
      text: JSON.stringify(
        { status: 200, ok: true, requestId: null, nextPath: null, body: { login: STUB_LOGIN } },
        null,
        2,
      ),
    },
  },
  [],
);
const GITHUB_KEPT = renderIntegrationReply("call", { kind: "running", command: "call" }, []);
const GITHUB_COLLECTED = renderIntegrationReply(
  "integrations",
  {
    kind: "earlier",
    command: "call",
    answer: {
      text: JSON.stringify(
        { status: 200, ok: true, requestId: null, nextPath: null, body: { login: STUB_LOGIN } },
        null,
        2,
      ),
    },
  },
  [],
);
const NOTES = SAMPLE_NOTES.map((note, index) => `${index + 1}. ${note}`).join("\n");
const NOTES_ANSWER = renderIntegrationReply(
  "call",
  { kind: "answer", answer: { text: NOTES } },
  [],
);
const NOTES_KEPT = renderIntegrationReply("call", { kind: "running", command: "call" }, []);
const NOTES_COLLECTED = renderIntegrationReply(
  "integrations",
  { kind: "earlier", command: "call", answer: { text: NOTES } },
  [],
);

const LIST = INTEGRATIONS_COMMAND;
const READ_GITHUB = `${INTEGRATIONS_COMMAND} call GitHub read '{"path":"/user"}'`;
const LIST_NOTES = `${INTEGRATIONS_COMMAND} call '${GITHUB_SERVER_NAME}' list_notes '{}'`;

/** The bash tool's answer to one command, in its own words: the output, or a job's receipt. */
async function bashAnswer(command: string, outcome: BashOutcome) {
  const tool = createEventBashTool(async () => outcome);
  const context = {} as Parameters<typeof tool.execute>[4];
  return (await tool.execute("bash", { command }, undefined, undefined, context)).content;
}

/**
 * A read the crewmate runs, what it printed, whether it outlasted the shell,
 * and whether the host asked when it will look again before the job exited.
 */
type Read = { command: string; printed: string; slow?: true; nudged?: true };

const CASES: { slow: string; reads: Read[] }[] = [
  {
    slow: "the integrations list",
    reads: [
      { command: LIST, printed: LISTED, slow: true },
      { command: READ_GITHUB, printed: GITHUB_ACCOUNT },
      { command: LIST_NOTES, printed: NOTES_ANSWER },
    ],
  },
  {
    slow: "GitHub's read",
    reads: [
      { command: LIST, printed: LISTED },
      { command: READ_GITHUB, printed: GITHUB_ACCOUNT, slow: true },
      { command: LIST_NOTES, printed: NOTES_ANSWER },
    ],
  },
  {
    slow: "the server's notes",
    reads: [
      { command: LIST, printed: LISTED },
      { command: READ_GITHUB, printed: GITHUB_ACCOUNT },
      { command: LIST_NOTES, printed: NOTES_ANSWER, slow: true },
    ],
  },
  {
    // The failed run's notes call was kept by the integrations command too.
    slow: "the command collecting the server's kept notes",
    reads: [
      { command: LIST, printed: LISTED },
      { command: READ_GITHUB, printed: GITHUB_ACCOUNT },
      { command: LIST_NOTES, printed: NOTES_KEPT },
      { command: LIST, printed: NOTES_COLLECTED, slow: true },
    ],
  },
  {
    // INF-1436, the order older-profile's Mac run captured: GitHub's read was
    // kept, the command collecting it outlasted the shell, and the host's
    // check-back ask came between its receipt and its exit wake.
    slow: "the command collecting GitHub's kept read, with the host's ask between",
    reads: [
      { command: LIST, printed: LISTED },
      { command: READ_GITHUB, printed: GITHUB_KEPT },
      { command: LIST, printed: GITHUB_COLLECTED, slow: true, nudged: true },
      { command: LIST_NOTES, printed: NOTES_ANSWER },
    ],
  },
];

for (const { slow, reads } of CASES) {
  test(`the GitHub-names crewmate waits for ${slow} past the shell's limit`, async () => {
    const answerer = githubNames();
    const messages: { role: string; content: unknown }[] = [
      { role: "user", content: `commission a crewmate: ${GITHUB_NAMES_PROMPT}` },
    ];
    const next = (): ScenarioAnswer | undefined => {
      const body = JSON.stringify({ messages });
      return answerer({
        body,
        isFirstmate: false,
        wantsStream: true,
        latestUserTail: body,
        hasToolResults: messages.length > 1,
        anthropicMessages: false,
        port: 0,
      });
    };
    const ran: string[] = [];
    for (const [index, read] of reads.entries()) {
      const answer = next();
      if (!answer || !("calls" in answer)) throw new Error(`Expected read ${index + 1}`);
      expect(answer.calls).toEqual([{ name: "bash", args: { command: read.command } }]);
      const call = answer.calls[0];
      if (!call) throw new Error("Missing tool call");
      ran.push(read.command);
      const jobId = `job${index}`;
      const content = await bashAnswer(
        read.command,
        read.slow
          ? { kind: "job", jobId, tail: "" }
          : { kind: "done", exitCode: 0, output: read.printed },
      );
      const id = `tool-${index}`;
      // Anthropic's tool-use/result shape, as the journey's Pi seat sends it.
      messages.push(
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name: call.name, input: call.args }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content }],
        },
      );
      if (!read.slow) continue;
      // The receipt is no answer: the turn ends without words or another read.
      expect(next()).toEqual({ text: "" });
      if (read.nudged) {
        // The host's ask while the job runs is a user message, never a new
        // assignment: the turn still ends without words or another read.
        messages.push({
          role: "user",
          content: frameServedInput([
            {
              kind: "wake",
              origin: "agent",
              body: renderWake(
                checkBackAsk(
                  { jobId, command: read.command, startedAt: 0 },
                  SYNC_CAP_MS,
                  JOB_BOUND_MS,
                ),
              ),
            },
          ]).text,
        });
        expect(next()).toEqual({ text: "" });
      }
      messages.push({
        role: "user",
        content: frameServedInput([
          {
            kind: "wake",
            origin: "agent",
            body: renderWake(
              jobExitWake(
                {
                  jobId,
                  ownerId: "crewmate",
                  command: read.command,
                  exitCode: 0,
                  durationMs: SYNC_CAP_MS + 1000,
                  tail: read.printed,
                },
                "crewmate",
              ),
            ),
          },
        ]).text,
      });
    }
    const report = next();
    if (!report || !("calls" in report) || report.calls[0]?.name !== "report")
      throw new Error("Expected the report");
    expect(ran).toEqual(reads.map((read) => read.command));
    const text = String(report.calls[0].args.text);
    expect(text.startsWith(GITHUB_NAMES_REPORT)).toBe(true);
    expect(text).toContain(GITHUB_SERVER_NAME);
    expect(text).toContain(STUB_LOGIN);
    for (const note of SAMPLE_NOTES) expect(text).toContain(note);
  });
}
