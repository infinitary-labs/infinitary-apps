import { frameServedInput, type ServedSegmentInput } from "@shared/servedFrame";
import { encode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_COMMAND } from "../src/core/browser/commandWords";
import { DELIVERY_CHANGES, DELIVERY_COMPLETE } from "../src/core/orchestrator/contextDelivery";
import {
  PENDING_RESPONSES_END,
  PENDING_RESPONSES_OPENING,
  renderWake,
} from "../src/core/orchestrator/wakes";
import { createEventBashTool } from "../src/core/pi/bashTool";
import { FIRSTMATE_PERSONA } from "../src/core/pi/piResources";
import {
  MOCK_FM_CHAT_TEXT,
  MOCK_FM_DONE_TEXT,
  type MockProviderServer,
  type Scenario,
  startMockProvider,
} from "./e2e/mockProvider";
import {
  captainCardChoice,
  latestContext,
  latestServedTurn,
  providerMessages,
  scriptedResponseInput,
} from "./e2e/providerRequest";
import { CI_REPAIR_MARKER } from "./e2e/scenarios/checkRepair";
import { CONTEXT_OVERFLOW_PROMPT_MARKER, contextOverflow } from "./e2e/scenarios/contextOverflow";
import { EMIT_CARDS_PROMPT_MARKER, everyCardKind } from "./e2e/scenarios/everyCardKind";
import {
  TASK_BROWSER_HANDOFF_MARKER,
  taskBrowserJourneys,
} from "./e2e/scenarios/taskBrowserJourneys";
import { workspaceInference } from "./e2e/scenarios/workspaceInference";
import type { ScriptedCall } from "./helpers/scriptedCalls";

let server: MockProviderServer | undefined;
afterEach(async () => server?.close());

function turn(repos: Array<{ name: string; repo_id: string }>, ask: string, crew: unknown[] = []) {
  return frameServedInput([
    {
      kind: "context",
      body: `[fm-op] context (not the user)\n${encode({ delivery: DELIVERY_COMPLETE, repos, crew })}`,
    },
    { kind: "user", origin: "captain", body: `[user]\n${ask}` },
  ]).text;
}

async function calls(messages: unknown[], scenarios: readonly Scenario[] = []) {
  server = await startMockProvider({ scenarios });
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "system", content: FIRSTMATE_PERSONA }, ...messages],
    }),
  });
  expect(response.ok).toBe(true);
  const chunks = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  return chunks
    .flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? [])
    .filter((call) => call.function.arguments)
    .map((call) => JSON.parse(call.function.arguments));
}

const alpha = { name: "alpha", repo_id: "repo-a" };
const beta = { name: "beta", repo_id: "repo-b" };

describe("mock provider consumes the current served snapshot", () => {
  it("offers each current project once despite repeated historical snapshots", async () => {
    const result = await calls(
      [
        { role: "user", content: turn([alpha], "hello") },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: turn([alpha, beta], "which project should take this: bump deps"),
            },
          ],
        },
      ],
      [workspaceInference],
    );
    expect(result[0].actions.map((action: { label: string }) => action.label)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("settles the current task, not an older task with the same title", async () => {
    const result = await calls([
      {
        role: "user",
        content: turn([], "hello", [{ task_id: "old", title: "status note", status: "idle" }]),
      },
      {
        role: "user",
        content: turn([], "finish the task status note", [
          { task_id: "new", title: "status note", status: "idle" },
        ]),
      },
    ]);
    expect(result[0].task_id).toBe("new");
  });

  it("does not bind a removed project from history", async () => {
    const result = await calls([
      { role: "user", content: turn([alpha], "hello") },
      { role: "user", content: turn([], "commission a crewmate: fix alpha") },
    ]);
    expect(result[0]).not.toHaveProperty("repo_id");
  });

  it("decodes quoted, multiline context fields independently of JSON formatting", () => {
    const title = 'a "quote", 東京\nand another line';
    const body = JSON.stringify(
      {
        messages: [
          { role: "user", content: turn([alpha], "old") },
          { role: "user", content: turn([], "hello", [{ task_id: "new", title, status: "idle" }]) },
        ],
      },
      null,
      2,
    );
    expect(latestContext(body)).toMatchObject({
      repos: [],
      crew: [{ task_id: "new", title, status: "idle" }],
    });
  });

  // INF-1712: a later context carries only what changed, so the reader
  // folds every context in order, as the model holds them.
  it("folds a context of changes onto the complete one before it", () => {
    const changes = (context: Record<string, unknown>) =>
      frameServedInput([
        {
          kind: "context",
          body: `[fm-op] context (not the user)\n${encode({ delivery: DELIVERY_CHANGES, ...context })}`,
        },
        { kind: "user", origin: "captain", body: "[user]\nnext" },
      ]).text;
    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: turn([alpha], "first", [
            { task_id: "t1", title: "Steady the meter", status: "running" },
            { task_id: "t2", title: "Fix the gauge", status: "idle" },
          ]),
        },
        {
          role: "user",
          content: changes({
            crew: {
              changed: [{ task_id: "t1", title: "Steady the meter", status: "idle" }],
              removed: ["t2"],
            },
          }),
        },
      ],
    });
    expect(latestContext(body)).toMatchObject({
      repos: [alpha],
      crew: [{ task_id: "t1", title: "Steady the meter", status: "idle" }],
    });
    expect(latestContext(body)?.crew).toHaveLength(1);
  });

  it("rejects a malformed current snapshot instead of falling back to history", () => {
    const malformed = frameServedInput([
      { kind: "context", body: "[fm-op] context (not the user)\nrepos[2]: a" },
    ]).text;
    expect(() =>
      latestContext(
        JSON.stringify({
          messages: [
            { role: "user", content: turn([alpha], "old") },
            { role: "user", content: malformed },
          ],
        }),
      ),
    ).toThrow();
  });
});

/** One Anthropic messages request, as Claude's client or Pi's Anthropic dialect sends it. */
function anthropicRequest(tools: string[], messages: unknown[]) {
  if (!server) throw new Error("start the mock provider first");
  return fetch(`http://127.0.0.1:${server.port}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      stream: true,
      system: [{ type: "text", text: "You are a crewmate." }],
      tools: tools.map((name) => ({ name, description: name, input_schema: { type: "object" } })),
      messages,
    }),
  });
}

/** The tool_use blocks a streamed Anthropic answer opened. */
async function toolUses(response: Response): Promise<Array<{ id: string; name: string }>> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type === "content_block_start")
    .map((event) => event.content_block)
    .filter((block) => block.type === "tool_use");
}

describe("mock provider speaks to Claude's own client", () => {
  const brief = [{ role: "user", content: [{ type: "text", text: EMIT_CARDS_PROMPT_MARKER }] }];

  it("calls a tool under the name the request serves it by", async () => {
    server = await startMockProvider({ scenarios: [everyCardKind] });
    const claude = await toolUses(await anthropicRequest(["mcp__infinitary__emit_card"], brief));
    expect(claude.length).toBeGreaterThan(0);
    expect(new Set(claude.map((call) => call.name))).toEqual(
      new Set(["mcp__infinitary__emit_card"]),
    );
    // A request that serves the plain name (Pi's Anthropic dialect) gets it.
    const pi = await toolUses(await anthropicRequest(["emit_card"], brief));
    expect(new Set(pi.map((call) => call.name))).toEqual(new Set(["emit_card"]));
  });
});

/** A served Firstmate input: the current board, then the given segments. */
function served(crew: unknown[], ...segments: ServedSegmentInput[]): string {
  return frameServedInput([
    {
      kind: "context",
      body: `[fm-op] context (not the user)\n${encode({ repos: [], crew, task_index: [] })}`,
    },
    ...segments,
  ]).text;
}

/**
 * The host's own words for a click on one of the Firstmate's cards: the
 * product renderer over the facts the host stamps (`crewSupervisor`), the
 * captain's click from the card chrome or a script's from inside the card.
 */
function cardChoice(
  source: "chrome" | "frame",
  card: { id: string; title: string; taskId: string },
): string {
  return renderWake({
    facts: { kind: "card-choice", to: "firstmate", source, card, choice: RETRY },
  });
}

/** One Firstmate request in the chat-completions dialect: the calls it answered with, or its text. */
async function firstmateAnswer(messages: unknown[], system = FIRSTMATE_PERSONA) {
  if (!server) throw new Error("start the mock provider first");
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  expect(response.ok).toBe(true);
  const deltas = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)).choices[0]?.delta ?? {});
  const calls: Array<{ name: string; args: string }> = [];
  for (const call of deltas.flatMap((delta) => delta.tool_calls ?? [])) {
    const entry = calls[call.index] ?? { name: "", args: "" };
    calls[call.index] = entry;
    entry.name += call.function?.name ?? "";
    entry.args += call.function?.arguments ?? "";
  }
  return {
    calls: calls.map((call) => ({ name: call.name, args: JSON.parse(call.args) })),
    text: deltas.map((delta) => delta.content ?? "").join(""),
  };
}

// INF-2214: new operational notices quote old assignments, not another command.
const responseNotice = renderWake({
  facts: {
    kind: "response-missing",
    requestId: "request-remover-path",
    taskId: "remover-path",
    turnId: "turn-path",
    question: "What is the full path to the remover?",
    report: "The file is shell-pc-job-host-remove.cmd.",
    references: { inboxId: 1, startedAt: 1, reportEventId: 2 },
  },
});

describe("correlated response notices in the scripted model", () => {
  // The failed check-repair provider transcript served a current read with
  // an older diagnose instruction inside the pending-request snapshot.
  it("routes the current worker command without replaying pending commands or dropping following assignment text", async () => {
    const current = `${CI_REPAIR_MARKER} read`;
    const older = `${CI_REPAIR_MARKER} diagnose`;
    const following =
      "\n\nCurrent review assignment (supersedes earlier heads):\nRead the new version.";
    const input = `${current}${PENDING_RESPONSES_OPENING}SCR-2 after context loss):\nrequest-previous: ${older}${PENDING_RESPONSES_END}${following}`;
    let seen: string | undefined;
    server = await startMockProvider({
      scenarios: [
        () =>
          ({ body }) => {
            seen = providerMessages(body)
              .filter((message) => message.role === "user")
              .at(-1)?.text;
            return {
              text: seen?.includes(older)
                ? "Repeated the old diagnosis."
                : "Read the current checks.",
            };
          },
      ],
    });
    const result = await firstmateAnswer([{ role: "user", content: input }], "Worker task");
    expect(result.text).toBe("Read the current checks.");
    expect(seen).toBe(current + following);
    expect(providerMessages(server.requestBodies()[0]!).at(-1)?.text).toBe(input);
  });

  it("acknowledges a notice without replaying a scenario and retains the actual input", async () => {
    let scenarioCalls = 0;
    server = await startMockProvider({
      scenarios: [
        () => () => {
          scenarioCalls += 1;
          return { calls: [STEER] };
        },
      ],
    });
    const input = served([], { kind: "wake", origin: "agent", body: responseNotice });
    const result = await firstmateAnswer([{ role: "user", content: input }]);
    expect(result.calls).toEqual([]);
    expect(result.text).not.toBe("");
    expect(scenarioCalls).toBe(0);
    expect(latestServedTurn(server.requestBodies()[0]!)?.segments.at(-1)?.body).toBe(
      responseNotice,
    );
  });

  it.each(["chat", "anthropic", "responses"] as const)(
    "keeps a concurrent captain request and tool results in %s",
    (dialect) => {
      const input = served(
        [],
        { kind: "wake", origin: "agent", body: responseNotice },
        { kind: "user", origin: "captain", body: "Keep the request open." },
      );
      const content =
        dialect === "chat"
          ? input
          : [{ type: dialect === "responses" ? "input_text" : "text", text: input }];
      const messages = [
        { role: "user", content },
        ...(dialect === "anthropic"
          ? [
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "read-path",
                    content: "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd",
                  },
                ],
              },
            ]
          : dialect === "responses"
            ? [
                {
                  type: "function_call_output",
                  call_id: "read-path",
                  output: "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd",
                },
              ]
            : [{ role: "tool", content: "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd" }]),
      ];
      const routed = scriptedResponseInput(
        JSON.stringify(dialect === "responses" ? { input: messages } : { messages }),
      );
      expect(routed.onlyNotices).toBe(false);
      const turn = latestServedTurn(routed.body)!;
      expect(turn.segments.filter((part) => part.kind !== "context")).toEqual([
        expect.objectContaining({
          kind: "user",
          origin: "captain",
          body: "Keep the request open.",
        }),
      ]);
      expect(turn.toolResults).toEqual(["C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd"]);
    },
  );
});

const TITLE = "Three findings rounds on the meter fix";
const RETRY = { id: "retry", label: "Retry with the findings" };
const NEW_CARD = { id: "card-fm-new", title: TITLE, taskId: "task-new" };
const OLD_CARD = { id: "card-fm-old", title: TITLE, taskId: "task-old" };
/** Two live tasks under one title, the older listed first. */
const SAME_TITLE_CREW = [
  { task_id: "task-old", title: "meterlab builder", status: "idle" },
  { task_id: "task-new", title: "meterlab builder", status: "idle" },
];
const STEER: ScriptedCall = {
  name: "steer_crewmate",
  args: { task_id: "task-new", message: "Retry with the findings." },
};

/** A tool loop's two legs after an input: the calls the model made, then their results. */
function answered(calls: ScriptedCall[], result: string) {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: calls.map((call, index) => ({
        id: `call_${index + 1}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    { role: "tool", tool_call_id: "call_1", content: result },
  ];
}

describe("the mock Firstmate answers a scripted turn by its whole served segment", () => {
  it("answers the captain's rendered choice with the scripted steer, then closes the loop", async () => {
    server = await startMockProvider();
    const script = server.scriptFirstmateTurn(captainCardChoice(NEW_CARD, RETRY), [STEER]);
    const click = {
      role: "user",
      content: served(SAME_TITLE_CREW, {
        kind: "user",
        origin: "captain",
        body: cardChoice("chrome", NEW_CARD),
      }),
    };

    expect((await firstmateAnswer([click])).calls).toEqual([
      {
        name: "steer_crewmate",
        args: { task_id: "task-new", message: "Retry with the findings." },
      },
    ]);
    expect(script.outcome()).toMatchObject({ state: "answered", results: [] });

    const close = await firstmateAnswer([click, ...answered([STEER], "Steered task-new.")]);
    expect(close).toEqual({ calls: [], text: MOCK_FM_DONE_TEXT });
    expect(script.outcome()).toEqual({
      state: "closed",
      unmatched: [],
      results: ["Steered task-new."],
    });
  });

  it("never takes a same-titled card from history or the board for the one the script names", async () => {
    server = await startMockProvider();
    const script = server.scriptFirstmateTurn(captainCardChoice(NEW_CARD, RETRY), [STEER]);
    const oldClick = {
      role: "user",
      content: served(SAME_TITLE_CREW, {
        kind: "user",
        origin: "captain",
        body: cardChoice("chrome", OLD_CARD),
      }),
    };

    // The same title and label on the older task's card is another choice:
    // it gets the ordinary reply, and the script records what it saw.
    expect(await firstmateAnswer([oldClick])).toEqual({ calls: [], text: MOCK_FM_CHAT_TEXT });
    const waiting = script.outcome();
    expect(waiting.state).toBe("armed");
    expect(waiting.unmatched).toHaveLength(1);
    expect(waiting.unmatched[0]).toContain("task-old");

    // With that choice in history, the named card's choice steers its own task.
    const newClick = {
      role: "user",
      content: served(SAME_TITLE_CREW, {
        kind: "user",
        origin: "captain",
        body: cardChoice("chrome", NEW_CARD),
      }),
    };
    const reply = await firstmateAnswer([
      oldClick,
      { role: "assistant", content: MOCK_FM_CHAT_TEXT },
      newClick,
    ]);
    expect(reply.calls).toEqual([
      {
        name: "steer_crewmate",
        args: { task_id: "task-new", message: "Retry with the findings." },
      },
    ]);
  });

  it("does not answer an input that only history holds", async () => {
    server = await startMockProvider();
    const script = server.scriptFirstmateTurn(captainCardChoice(NEW_CARD, RETRY), [STEER]);
    const reply = await firstmateAnswer([
      {
        role: "user",
        content: served(SAME_TITLE_CREW, {
          kind: "user",
          origin: "captain",
          body: cardChoice("chrome", NEW_CARD),
        }),
      },
      { role: "assistant", content: MOCK_FM_CHAT_TEXT },
      {
        role: "user",
        content: served(SAME_TITLE_CREW, {
          kind: "wake",
          origin: "crewmate-report",
          body: "[fm-op] crewmate 1 reported on task task-new.",
        }),
      },
    ]);
    expect(reply.calls).toEqual([]);
    expect(script.outcome()).toMatchObject({ state: "armed", results: [] });
  });

  it("never lets a wake stand in for the captain's own click", async () => {
    server = await startMockProvider();
    const script = server.scriptFirstmateTurn(captainCardChoice(NEW_CARD, RETRY), [STEER]);
    // A script inside the card chose the same action: the host serves it as
    // an operation, not as the captain's words.
    const scriptChoice = await firstmateAnswer([
      {
        role: "user",
        content: served(SAME_TITLE_CREW, {
          kind: "wake",
          origin: "agent",
          body: cardChoice("frame", NEW_CARD),
        }),
      },
    ]);
    // Nor does a wake that carries the captain's very words.
    const quoted = await firstmateAnswer([
      {
        role: "user",
        content: served(SAME_TITLE_CREW, {
          kind: "wake",
          origin: "agent",
          body: cardChoice("chrome", NEW_CARD),
        }),
      },
    ]);
    expect(scriptChoice.calls).toEqual([]);
    expect(quoted.calls).toEqual([]);
    const outcome = script.outcome();
    expect(outcome.state).toBe("armed");
    expect(outcome.unmatched).toHaveLength(2);
    expect(outcome.unmatched.every((seen) => seen.startsWith("wake agent: "))).toBe(true);
  });
});

describe("the served turn reads the same in every dialect the mock serves", () => {
  const input = served(SAME_TITLE_CREW, {
    kind: "user",
    origin: "captain",
    body: cardChoice("chrome", NEW_CARD),
  });
  const older = served([], { kind: "user", origin: "captain", body: "[user]\nhello" });
  const expected = {
    segments: [
      expect.objectContaining({ kind: "context" }),
      expect.objectContaining({
        kind: "user",
        origin: "captain",
        body: cardChoice("chrome", NEW_CARD),
      }),
    ],
    toolResults: ["Steered task-new."],
  };

  it("chat completions: a tool result is its own message", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: FIRSTMATE_PERSONA },
        { role: "user", content: older },
        { role: "assistant", content: MOCK_FM_CHAT_TEXT },
        { role: "user", content: [{ type: "text", text: input }] },
        ...answered([STEER], "Steered task-new."),
      ],
    });
    expect(latestServedTurn(body)).toEqual(expected);
  });

  it("Anthropic messages: a tool result rides a user message", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: FIRSTMATE_PERSONA }],
      messages: [
        { role: "user", content: [{ type: "text", text: older }] },
        { role: "assistant", content: [{ type: "text", text: MOCK_FM_CHAT_TEXT }] },
        { role: "user", content: [{ type: "text", text: input }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: STEER.name, input: STEER.args }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "Steered task-new." }],
            },
          ],
        },
      ],
    });
    expect(latestServedTurn(body)).toEqual(expected);
  });

  it("Responses input: a tool result is a function_call_output item", () => {
    const body = JSON.stringify({
      instructions: FIRSTMATE_PERSONA,
      input: [
        { role: "user", content: [{ type: "input_text", text: older }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: MOCK_FM_CHAT_TEXT }],
        },
        { role: "user", content: [{ type: "input_text", text: input }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: STEER.name,
          arguments: JSON.stringify(STEER.args),
        },
        { type: "function_call_output", call_id: "call_1", output: "Steered task-new." },
      ],
    });
    expect(latestServedTurn(body)).toEqual(expected);
  });

  it("an input the host did not frame is no served turn, whatever history holds", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: input },
        { role: "user", content: "plain words" },
      ],
    });
    expect(latestServedTurn(body)).toBeUndefined();
  });
});

describe("browser journeys consume background shell answers", () => {
  it.each(["", "page: Partial output"])(
    "waits for a matching job exit, ignoring receipt tail %j",
    async (tail) => {
      // INF-634: task-browser:833 reported the shell receipt as the browser's
      // refusal under load, after INF-181 and INF-531. Use the product's words.
      server = await startMockProvider({ scenarios: [taskBrowserJourneys] });
      const command = `${BROWSER_COMMAND} open http://127.0.0.1:5555/`;
      const jobId = "34a0ca8f";
      const tool = createEventBashTool(async () => ({ kind: "job", jobId, tail }));
      const receipt = await tool.execute(
        "open",
        { command },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      );
      const messages = [
        { role: "user", content: `${TASK_BROWSER_HANDOFF_MARKER}http://127.0.0.1:5555/` },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "open",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "open", content: receipt.content },
      ];
      const answer = () => firstmateAnswer(messages, "You are a crewmate.");
      expect((await answer()).calls).toEqual([]);
      const wake = (id: string, tail: string) =>
        frameServedInput([
          {
            kind: "wake",
            origin: "agent",
            body: renderWake({
              facts: {
                kind: "job-exit",
                to: "crewmate",
                jobId: id,
                command,
                exitCode: 0,
                durationMs: 3400,
                tail,
              },
            }),
          },
        ]).text;
      // An unrelated exit is not the answer; even a partial browser tail in
      // the receipt must not be used before this shell finishes.
      messages.push({ role: "user", content: wake("other-job", "page: Wrong browser") });
      expect((await answer()).calls).toEqual([]);
      const page =
        'page: Sign in\noutline: lines 1-2 of 2\nheading "Sign in" (level 1)\nbutton "Sign in" [g1:e1]';
      messages.push({ role: "user", content: wake(jobId, page) });
      expect((await answer()).calls.map((call) => call.name)).toEqual(["emit_card"]);
      // A repeated wake is not a second browser answer.
      messages.push({ role: "user", content: wake(jobId, page) });
      expect((await answer()).calls.map((call) => call.name)).toEqual(["emit_card"]);
      // The command can itself park an operation. Read it once via the bare
      // command, rather than repeating open when its shell job ends.
      messages.splice(-2, 2, { role: "user", content: wake(jobId, "running: open") });
      expect((await answer()).calls).toEqual([
        {
          name: "bash",
          args: { command: BROWSER_COMMAND, description: "Use this task's browser" },
        },
      ]);
      messages.push({
        role: "tool",
        content: `exit 0\nearlier: Your earlier open finished\n${page}`,
      });
      expect((await answer()).calls.map((call) => call.name)).toEqual(["emit_card"]);
    },
  );
});

/** One Firstmate request carrying the captain's served words: the status and what came back. */
async function captainSays(provider: MockProviderServer, ask: string) {
  const response = await fetch(`http://127.0.0.1:${provider.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [
        { role: "system", content: FIRSTMATE_PERSONA },
        { role: "user", content: turn([alpha], ask) },
      ],
    }),
  });
  return { status: response.status, text: await response.text() };
}

// INF-518: a journey names the scenarios it needs when it launches the app,
// and only those answer it (docs/testing.md, "A journey's own scenarios").
describe("a journey's own scenarios", () => {
  const ask = `hello ${CONTEXT_OVERFLOW_PROMPT_MARKER}`;

  it("answer only on the stand-in started with them", async () => {
    server = await startMockProvider();
    expect((await captainSays(server, ask)).status).toBe(200);
  });

  it("are asked before the shared answers, and each start keeps its own state", async () => {
    server = await startMockProvider({ scenarios: [contextOverflow] });
    const refused = await captainSays(server, ask);
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text).error.message).toMatch(/^prompt is too long/);
    expect((await captainSays(server, ask)).status).toBe(200);
    await server.close();
    server = await startMockProvider({ scenarios: [contextOverflow] });
    expect((await captainSays(server, ask)).status).toBe(400);
  });
});

it("INF-909 retains decoded stand-in requests in order, including history and tool-result follow-ups", async () => {
  server = await startMockProvider();
  const send = async (messages: unknown[]) => {
    const response = await fetch(`http://127.0.0.1:${server?.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-only-not-retained",
      },
      body: JSON.stringify({ model: "mock", stream: true, messages }),
    });
    expect(response.ok).toBe(true);
    await response.text();
  };
  const initial = [{ role: "user", content: "hello" }];
  await send(initial);
  const recorded: string[] = [];
  const stop = server.recordRequests((body) => recorded.push(body));
  await send([...initial, { role: "tool", tool_call_id: "call-1", content: "card emitted" }]);
  expect(recorded).toEqual(server.requestBodies());
  expect(recorded).toHaveLength(2);
  expect(recorded.join("\n")).not.toContain("test-only-not-retained");
  stop();
  await send(initial);
  expect(recorded).toHaveLength(2);
});
