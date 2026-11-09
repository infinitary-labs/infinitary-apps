/**
 * The journey stand-in's server, through HTTP (INF-2625's plan, the journey
 * stand-ins piece). Every journey talks to `startMockProvider` over the three
 * wires the app's model clients speak; before that file is split along its
 * owners, these tests hold what each wire carries and how each built-in
 * script and control answers, so the split can move the code and nothing a
 * journey reads changes. They speak to the server only as a client does: a
 * request in, the decoded answer out.
 */
import { zstdCompressSync } from "node:zlib";
import { frameServedInput } from "@shared/servedFrame";
import { encode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_MISSING_ENDED_OPENING,
  ANSWER_MISSING_OPENING,
} from "../src/core/orchestrator/captainWakes";
import { DELIVERY_COMPLETE } from "../src/core/orchestrator/contextDelivery";
import { BUILD_IN_PLACE_OPENING } from "../src/core/orchestrator/intentBrief";
import { WELCOME_WAKE_WORDS } from "../src/core/orchestrator/noticeWakes";
import { FINISHED_REPORT_WORDS } from "../src/core/orchestrator/reportWakes";
import { FIRSTMATE_PERSONA, KIND_CLASSIFIER_OPENING } from "../src/core/pi/piResources";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../src/core/storage/sessionReader";
import { WRITE_ASK_ANSWER_MARKER } from "./e2e/apiWriteCases";
import {
  CLAUDE_CARD_RETIRE_MARKER,
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_HELD_CARD_MARKER,
  CLAUDE_HELD_REPLY,
  CLAUDE_REFUSAL_OVER_MARKER,
  CLAUDE_REFUSED_PROMPT_MARKER,
  CLAUDE_STEER_MARKER,
  MOCK_CLAUDE_CARD_TITLE,
  MOCK_CLAUDE_HELD_ANSWER,
  MOCK_CLAUDE_HELD_CARD_TITLE,
  MOCK_CLAUDE_HELD_PROGRESS,
  MOCK_CLAUDE_REFUSAL_OVER_REPORT,
  MOCK_CLAUDE_STEERED_REPORT,
  MOCK_PANEL_ID,
  MOCK_PANEL_NOTE_TITLE,
  MOCK_PANEL_REPORT,
  MOCK_PANEL_REVISED_REPORT,
  THREAD_ACK_ANSWER,
  THREAD_ACK_REPLY,
  THREAD_ACK_REVISED_TITLE,
  THREAD_ACK_TEXT,
  THREAD_CARD_REVISED_TITLE,
  THREAD_CARD_TITLE,
  THREAD_PROMPT_MARKER,
  THREAD_PROSE_ANSWER,
  THREAD_PROSE_REPLY,
  THREAD_REVISE_ANSWER,
  THREAD_REVISE_REPLY,
} from "./e2e/crewScripts";
import { MOCK_MODEL_ID } from "./e2e/mockModels";
import {
  ANSWER_PROMPT_MARKER,
  APP_CATALOG_PROMPT_MARKER,
  AUTONOMY_ASK_MARKER,
  CANCEL_PROMPT_MARKER,
  CARD_FETCH_PROBE_PATH,
  CLASSIFY_CHORE_MARKER,
  CLAUDE_CREW_MODEL,
  DISCARD_PROMPT_MARKER,
  FAIL_AUTH_PROMPT_MARKER,
  FAIL_PROVIDER_PROMPT_MARKER,
  FM_SEAT_HOLD_MARKER,
  FM_SEAT_STEER_WORD,
  FM_SEAT_STEERED_TITLE,
  LAND_PROMPT_MARKER,
  MERGE_PROMPT_MARKER,
  MOCK_ANSWER_TEXT,
  MOCK_ANSWER_TITLE,
  MOCK_CLOSING_SENTENCES,
  MOCK_COMPLETION_TEXT,
  MOCK_FM_CHAT_TEXT,
  MOCK_FM_DONE_TEXT,
  MOCK_FOLLOWUP_TITLE,
  MOCK_RISK,
  type MockProviderServer,
  REACT_PROMPT_MARKER,
  RETRIEVAL_TASK_GOAL,
  RETRY_ACTS_MARKER,
  RETRY_ANSWER_TITLE,
  RETRY_SILENT_MARKER,
  REVIEW_CAREFULLY_MARKER,
  REVIEWED_TIER_PROMPT_MARKER,
  type Scenario,
  type ScenarioRequest,
  SEQ_REPRODUCE_GOAL,
  SILENT_ANSWER_MARKER,
  SPAWN_PROMPT_MARKER,
  STANDARD_TIER_HOST_BUTTONS_MARKER,
  STANDARD_TIER_PROMPT_MARKER,
  STEER_PROMPT_MARKER,
  startMockProvider,
  TALL_ANSWER_PROMPT_MARKER,
  THREAD_TREE_PARENT_KEY,
  THREAD_TREE_PROMPT_MARKER,
} from "./e2e/mockProvider";
import type { ScriptedCall } from "./helpers/scriptedCalls";

let server: MockProviderServer | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = undefined;
});

async function start(scenarios: readonly Scenario[] = []): Promise<MockProviderServer> {
  server = await startMockProvider({ scenarios });
  return server;
}

type Dialect = "chat" | "responses" | "anthropic";
/** Where each client sends its turns: Pi's completions, a Responses provider, Claude's client. */
const PATHS: Record<Dialect, string> = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  anthropic: "/v1/messages?beta=true",
};

/** One server-sent event as a client reads it: its name, where the wire names one, and its data. */
type WireEvent = { event?: string; data: unknown };

function sse(raw: string): WireEvent[] {
  return raw
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      return { ...(event ? { event } : {}), data: data === "[DONE]" ? data : JSON.parse(data) };
    });
}

/** The calls and text one streamed answer carried, read the way each dialect's client reads it. */
function answerOf(dialect: Dialect, events: WireEvent[]) {
  const calls: Array<{ name: string; args: string }> = [];
  let text = "";
  for (const { data } of events) {
    if (data === "[DONE]") continue;
    const payload = data as Record<string, any>;
    if (dialect === "chat") {
      const delta = payload.choices?.[0]?.delta ?? {};
      text += delta.content ?? "";
      for (const call of delta.tool_calls ?? []) {
        const entry = calls[call.index] ?? { name: "", args: "" };
        calls[call.index] = entry;
        entry.name += call.function?.name ?? "";
        entry.args += call.function?.arguments ?? "";
      }
    } else if (dialect === "responses") {
      if (payload.type === "response.output_text.delta") text += payload.delta;
      if (payload.type === "response.output_item.done" && payload.item.type === "function_call")
        calls.push({ name: payload.item.name, args: payload.item.arguments });
    } else {
      if (payload.type === "content_block_start" && payload.content_block.type === "tool_use")
        calls[payload.index] = { name: payload.content_block.name, args: "" };
      if (payload.delta?.type === "input_json_delta")
        (calls[payload.index] as { args: string }).args += payload.delta.partial_json;
      if (payload.delta?.type === "text_delta") text += payload.delta.text;
    }
  }
  return { calls: calls.map((call) => ({ name: call.name, args: JSON.parse(call.args) })), text };
}

type Sent = {
  /** The system or instructions text. */
  system?: string;
  /** The request's messages in its dialect's own shape. */
  messages: unknown[];
  /** Tool names the request serves (Anthropic dialect). */
  tools?: string[];
  stream?: boolean;
  zstd?: boolean;
};

function bodyOf(dialect: Dialect, sent: Sent): string {
  const stream = sent.stream ?? true;
  if (dialect === "responses")
    return JSON.stringify({
      model: MOCK_MODEL_ID,
      stream,
      instructions: sent.system ?? "You are a crewmate.",
      input: sent.messages,
    });
  if (dialect === "anthropic")
    return JSON.stringify({
      model: "claude-haiku-4-5",
      stream,
      system: [{ type: "text", text: sent.system ?? "You are a crewmate." }],
      tools: (sent.tools ?? []).map((name) => ({
        name,
        description: name,
        input_schema: { type: "object" },
      })),
      messages: sent.messages,
    });
  return JSON.stringify({
    model: MOCK_MODEL_ID,
    stream,
    messages: [{ role: "system", content: sent.system ?? "You are a crewmate." }, ...sent.messages],
  });
}

function post(dialect: Dialect, sent: Sent): Promise<Response> {
  if (!server) throw new Error("start the stand-in first");
  const body = bodyOf(dialect, sent);
  return fetch(`http://127.0.0.1:${server.port}${PATHS[dialect]}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sent.zstd ? { "Content-Encoding": "zstd" } : {}),
    },
    body: sent.zstd ? zstdCompressSync(Buffer.from(body)) : body,
  });
}

/** One streamed turn: its status, its events, and the calls and text they carried. */
async function ask(dialect: Dialect, sent: Sent) {
  const response = await post(dialect, sent);
  const raw = await response.text();
  if (!response.ok) return { status: response.status, raw, events: [], calls: [], text: "" };
  const events = sse(raw);
  return { status: response.status, raw, events, ...answerOf(dialect, events) };
}

/** The calls' names, the shortest way to read which branch answered. */
const names = (answer: { calls: Array<{ name: string }> }) => answer.calls.map((call) => call.name);

/** The newest user message, in each dialect's shape. */
function user(dialect: Dialect, text: string) {
  if (dialect === "chat") return { role: "user", content: text };
  if (dialect === "responses") return { role: "user", content: [{ type: "input_text", text }] };
  return { role: "user", content: [{ type: "text", text }] };
}

/** A tool call as an earlier leg carries it on the wire: the served name and whatever arguments were sent. */
type SentCall = { name: string; args: unknown };

/** A tool loop's two legs after an input, in each dialect's shape: the calls, then one result each. */
function loop(dialect: Dialect, calls: SentCall[], result = "ok") {
  const ids = calls.map((_, index) => `call_${index + 1}`);
  if (dialect === "chat")
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call, index) => ({
          id: ids[index],
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
      ...ids.map((id) => ({ role: "tool", tool_call_id: id, content: result })),
    ];
  if (dialect === "responses")
    return [
      ...calls.map((call, index) => ({
        type: "function_call",
        call_id: ids[index],
        name: call.name,
        arguments: JSON.stringify(call.args),
      })),
      ...ids.map((id) => ({ type: "function_call_output", call_id: id, output: result })),
    ];
  return [
    {
      role: "assistant",
      content: calls.map((call, index) => ({
        type: "tool_use",
        id: ids[index],
        name: call.name,
        input: call.args,
      })),
    },
    {
      role: "user",
      content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: result })),
    },
  ];
}

/** A served first mate input: the board, then the captain's words. */
function turn(ask: string, crew: unknown[] = [], repos: unknown[] = []): string {
  return frameServedInput([
    {
      kind: "context",
      body: `[fm-op] context (not the user)\n${encode({ delivery: DELIVERY_COMPLETE, repos, crew })}`,
    },
    { kind: "user", origin: "captain", body: `[user]\n${ask}` },
  ]).text;
}

/** One first mate turn on Pi's completions wire, after `history`. */
const firstmate = (
  words: string,
  history: unknown[] = [],
  crew: unknown[] = [],
  repos: unknown[] = [],
) =>
  ask("chat", {
    system: FIRSTMATE_PERSONA,
    messages: [...history, user("chat", turn(words, crew, repos))],
  });

/** Resolves once the stand-in has read its next request, so a held answer's count is current. */
function nextRequest(provider: MockProviderServer): Promise<void> {
  let stop = () => {};
  const seen = provider.requestBodies().length;
  return new Promise<void>((resolve) => {
    stop = provider.recordRequests(() => {
      if (provider.requestBodies().length > seen) resolve();
    });
  }).finally(() => stop());
}

describe("the stand-in's own paths", () => {
  it("answers Claude's reachability check, counts card fetches and refuses any other path", async () => {
    const provider = await start();
    const base = `http://127.0.0.1:${provider.port}`;
    expect((await fetch(`${base}/api/hello`, { method: "HEAD" })).status).toBe(200);
    const probe = await fetch(`${base}${CARD_FETCH_PROBE_PATH}?from=card`);
    expect(await probe.text()).toBe("reached");
    expect(probe.headers.get("access-control-allow-origin")).toBe("*");
    expect(provider.cardFetchProbeHits()).toBe(1);
    const other = await fetch(`${base}/v1/models`);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "not found" });
    expect(provider.requests()).toBe(0);
  });

  it("reads a body Codex's client compressed, and keeps it and its headers in order", async () => {
    const provider = await start();
    const plain = await ask("responses", { messages: [user("responses", "hello")] });
    const packed = await ask("responses", { messages: [user("responses", "hello")], zstd: true });
    expect(packed.text).toBe(plain.text);
    const [first, second] = provider.requestBodies();
    expect(second).toBe(first);
    expect(provider.requestHeaders()[1]?.["content-encoding"]).toBe("zstd");
    expect(provider.requests()).toBe(2);
  });

  it("answers a request that asks for no stream with one completion", async () => {
    await start();
    const response = await post("chat", { messages: [user("chat", "hello")], stream: false });
    expect(await response.json()).toEqual({
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: expect.any(Number),
      model: MOCK_MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: MOCK_COMPLETION_TEXT },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
    });
  });
});

// G1: each wire's whole answer, event by event, for one text turn and one tool turn.
describe("each wire carries a text turn and a tool turn the way its client reads them", () => {
  const CALLS: ScriptedCall[] = [
    { name: "note_progress", args: { text: "Halfway." } },
    { name: "report", args: { text: "Done." } },
  ];
  const calling: Scenario = () => (request) =>
    request.body.includes("call the tools") ? { calls: CALLS } : undefined;
  const usage = { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 };

  it("chat completions: a role delta, the text in twelve-character pieces, the stop and [DONE]", async () => {
    await start();
    const { events, text } = await ask("chat", { messages: [user("chat", "hello")] });
    const base = {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: expect.any(Number),
      model: MOCK_MODEL_ID,
    };
    const pieces = MOCK_COMPLETION_TEXT.match(/[\s\S]{1,12}/g) ?? [];
    expect(events).toEqual([
      {
        data: {
          ...base,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
      },
      ...pieces.map((piece) => ({
        data: { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] },
      })),
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage } },
      { data: "[DONE]" },
    ]);
    expect(text).toBe(MOCK_COMPLETION_TEXT);
  });

  it("chat completions: each call opens with its name, then its arguments, then tool_calls", async () => {
    await start([calling]);
    const { events, calls } = await ask("chat", { messages: [user("chat", "call the tools")] });
    const base = {
      id: "chatcmpl-mock-tools",
      object: "chat.completion.chunk",
      created: expect.any(Number),
      model: MOCK_MODEL_ID,
    };
    const choice = (delta: unknown, finish_reason: string | null = null) => ({
      ...base,
      choices: [{ index: 0, delta, finish_reason }],
    });
    expect(events).toEqual([
      { data: choice({ role: "assistant" }) },
      ...CALLS.flatMap((call, index) => [
        {
          data: choice({
            tool_calls: [
              {
                index,
                id: `call_1_${index + 1}`,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          }),
        },
        {
          data: choice({
            tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }],
          }),
        },
      ]),
      { data: { ...choice({}, "tool_calls"), usage } },
      { data: "[DONE]" },
    ]);
    expect(calls).toEqual(CALLS.map((call) => ({ name: call.name, args: call.args })));
  });

  it("Responses: created, one message item, completed with the usage in its own names", async () => {
    await start();
    const { events, text } = await ask("responses", { messages: [user("responses", "hello")] });
    const item = { type: "message", id: "msg_1", role: "assistant" };
    expect(events).toEqual([
      {
        event: "response.created",
        data: { type: "response.created", response: { id: "resp_mock_1", status: "in_progress" } },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [] },
        },
      },
      {
        event: "response.output_text.delta",
        data: { type: "response.output_text.delta", output_index: 0, delta: MOCK_COMPLETION_TEXT },
      },
      {
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...item, content: [{ type: "output_text", text: MOCK_COMPLETION_TEXT }] },
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_mock_1",
            status: "completed",
            usage: { input_tokens: 42, output_tokens: 17, total_tokens: 59 },
          },
        },
      },
    ]);
    expect(text).toBe(MOCK_COMPLETION_TEXT);
  });

  it("Responses: one function_call item per call, its arguments in one delta", async () => {
    await start([calling]);
    const { events, calls } = await ask("responses", {
      messages: [user("responses", "call the tools")],
    });
    expect(events.map(({ event }) => event)).toEqual([
      "response.created",
      ...CALLS.flatMap(() => [
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.output_item.done",
      ]),
      "response.completed",
    ]);
    const item = (index: number) => ({
      type: "function_call",
      id: `fc_1_${index + 1}`,
      call_id: `call_1_${index + 1}`,
      name: CALLS[index]?.name,
    });
    expect(events.slice(1, 4).map(({ data }) => data)).toEqual([
      { type: "response.output_item.added", output_index: 0, item: { ...item(0), arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: JSON.stringify(CALLS[0]?.args),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...item(0), arguments: JSON.stringify(CALLS[0]?.args) },
      },
    ]);
    expect(calls).toEqual(CALLS.map((call) => ({ name: call.name, args: call.args })));
  });

  it("Anthropic messages: message_start, one text block, end_turn", async () => {
    await start();
    const { events, text } = await ask("anthropic", { messages: [user("anthropic", "hello")] });
    expect(events).toEqual([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_mock_1",
            type: "message",
            role: "assistant",
            model: "mock-1",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 42, output_tokens: 0 },
          },
        },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: MOCK_COMPLETION_TEXT },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 17 },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    expect(text).toBe(MOCK_COMPLETION_TEXT);
  });

  it("Anthropic messages: one tool_use block per call, ending tool_use", async () => {
    await start([calling]);
    const { events, calls } = await ask("anthropic", {
      messages: [user("anthropic", "call the tools")],
    });
    expect(events.map(({ event }) => event)).toEqual([
      "message_start",
      ...CALLS.flatMap(() => ["content_block_start", "content_block_delta", "content_block_stop"]),
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]?.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1_1", name: "note_progress", input: {} },
    });
    expect((events.at(-2)!.data as { delta: unknown }).delta).toEqual({
      stop_reason: "tool_use",
      stop_sequence: null,
    });
    expect(calls).toEqual(CALLS.map((call) => ({ name: call.name, args: call.args })));
  });

  // mockProvider.test.ts owns the app-tool prefix; this case owns the shell, which Claude serves as Bash.
  it("Anthropic messages: a scripted shell call goes out as Bash to Claude's client and bash to Pi", async () => {
    await start([
      () => (request) =>
        request.body.includes("shell")
          ? { calls: [{ name: "bash", args: { command: "true" } }] }
          : undefined,
    ]);
    const claude = await ask("anthropic", {
      messages: [user("anthropic", "shell")],
      tools: ["Bash"],
    });
    expect(names(claude)).toEqual(["Bash"]);
    const pi = await ask("anthropic", {
      messages: [user("anthropic", "shell")],
      tools: ["bash"],
    });
    expect(names(pi)).toEqual(["bash"]);
  });
});

// A crewmate's completion decision carries its risk, as the real emit_card asks; the first mate's never does.
describe("a crewmate's merge card goes out with the risk it must declare", () => {
  const merge = { id: "merge", default: true, effect: { kind: "merge", after: "close" } };
  const card = (extra: Record<string, unknown> = {}): ScriptedCall =>
    ({
      name: "emit_card",
      args: { title: "Fixed the meter", body: "<p>Done.</p>", actions: [merge], ...extra },
    }) as ScriptedCall;
  const cards: Record<string, ScriptedCall> = {
    plain: card(),
    named: card({
      risk: { ...MOCK_RISK, blast: { level: "high", why: "Shared code" } },
      required_actions: [],
    }),
    story: card({ presentation: 1 }),
    note: { name: "emit_card", args: { title: "A note", body: "<p>Done.</p>" } } as ScriptedCall,
  };
  const scenario: Scenario = () => (request) => {
    const which = Object.keys(cards).find((key) => request.body.includes(`card ${key}`));
    return which ? { calls: [cards[which] as ScriptedCall] } : undefined;
  };

  it.each(["chat", "responses", "anthropic"] as const)("on the %s wire", async (dialect) => {
    await start([scenario]);
    const sent = async (which: string, system?: string) =>
      (await ask(dialect, { system, messages: [user(dialect, `card ${which}`)] })).calls[0]?.args;
    expect(await sent("plain")).toEqual({
      ...cards.plain?.args,
      risk: MOCK_RISK,
      required_actions: [],
    });
    expect(await sent("named")).toEqual(cards.named?.args);
    expect(await sent("story")).toEqual(cards.story?.args);
    expect(await sent("note")).toEqual(cards.note?.args);
    expect(await sent("plain", FIRSTMATE_PERSONA)).toEqual(cards.plain?.args);
  });
});

// G2: what a scenario reads of a request, the same facts on each wire.
describe("what a scenario reads of a request", () => {
  async function seen(dialect: Dialect, sent: Sent): Promise<ScenarioRequest> {
    let request: ScenarioRequest | undefined;
    await start([
      () => (each) => {
        request = each;
        return { text: "seen" };
      },
    ]);
    await ask(dialect, sent);
    if (!request) throw new Error("the scenario was not asked");
    return request;
  }

  it.each(["chat", "responses", "anthropic"] as const)(
    "%s: the newest user message's words, never an older message's",
    async (dialect) => {
      const request = await seen(dialect, {
        messages: [user(dialect, "older words"), user(dialect, "newest words")],
      });
      expect(request.latestUserTail).toContain("newest words");
      expect(request.latestUserTail).not.toContain("older words");
      expect(request.hasToolResults).toBe(false);
      expect(request.isFirstmate).toBe(false);
      expect(request.wantsStream).toBe(true);
      expect(request.anthropicMessages).toBe(dialect === "anthropic");
      expect(request.port).toBe(server?.port);
      expect(request.body).toContain("older words");
    },
  );

  it.each(["chat", "responses", "anthropic"] as const)(
    "%s: a tool loop after the newest message is a follow-up leg",
    async (dialect) => {
      const call: ScriptedCall = { name: "report", args: { text: "Done." } };
      const request = await seen(dialect, {
        system: FIRSTMATE_PERSONA,
        messages: [
          user(dialect, "older words"),
          user(dialect, "newest words"),
          ...loop(dialect, [call], "reported"),
        ],
      });
      expect(request.hasToolResults).toBe(true);
      expect(request.isFirstmate).toBe(true);
      expect(request.latestUserTail).not.toContain("older words");
      // Claude's client sends a tool result in a user message of its own, so the
      // newest user message is that result, not the words before it.
      if (dialect === "anthropic") expect(request.latestUserTail).not.toContain("newest words");
      else expect(request.latestUserTail).toContain("newest words");
    },
  );

  it("a request that asks for no stream says so", async () => {
    const request = await seen("chat", { messages: [user("chat", "hello")], stream: false });
    expect(request.wantsStream).toBe(false);
  });
});

describe("a scenario's answer", () => {
  it("can wait before it answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const provider = await start([() => () => ({ text: "later", afterMs: 30_000 })]);
    const read = nextRequest(provider);
    const answer = ask("chat", { messages: [user("chat", "hello")] });
    await read;
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await answer).text).toBe("later");
  });

  it("can hold a crewmate's step open until the spec releases it", async () => {
    const provider = await start([() => () => ({ held: true })]);
    const response = await post("anthropic", {
      messages: [user("anthropic", "work on")],
      tools: ["note_progress"],
    });
    expect(provider.heldRequests()).toBe(1);
    provider.releaseHeldCrew();
    const answer = answerOf("anthropic", sse(await response.text()));
    expect(answer.calls).toEqual([
      { name: "note_progress", args: { text: MOCK_CLAUDE_HELD_PROGRESS } },
    ]);
    expect(provider.heldRequests()).toBe(0);
  });

  it("can refuse the way the service does", async () => {
    await start([
      () => () => ({
        refusal: { status: 529, error: { type: "overloaded_error", message: "Overloaded" } },
      }),
    ]);
    const response = await post("anthropic", { messages: [user("anthropic", "hello")] });
    expect(response.status).toBe(529);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
  });
});

describe("the first mate's failures", () => {
  it("refuses a turn with a 401 or a provider error on the captain's words, but not on a tool loop's leg", async () => {
    await start();
    const auth = await firstmate(FAIL_AUTH_PROMPT_MARKER);
    expect(auth.status).toBe(401);
    expect(JSON.parse(auth.raw).error).toMatchObject({
      code: "invalid_api_key",
      type: "invalid_request_error",
    });
    const provider = await firstmate(FAIL_PROVIDER_PROMPT_MARKER);
    expect(provider.status).toBe(400);
    expect(JSON.parse(provider.raw).error.message).toBe("mock deterministic provider failure");
    const leg = await ask("chat", {
      system: FIRSTMATE_PERSONA,
      messages: [
        user("chat", turn(FAIL_AUTH_PROMPT_MARKER)),
        ...loop("chat", [{ name: "crew_status", args: {} }]),
      ],
    });
    expect(leg.status).toBe(200);
  });

  it("refuses every first mate turn while failFirstmate is on, and no crewmate's", async () => {
    const provider = await start();
    provider.failFirstmate(true);
    const refused = await firstmate("hello");
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.raw).error.message).toBe("mock deterministic inference failure");
    expect((await ask("chat", { messages: [user("chat", "hello")] })).status).toBe(200);
    provider.failFirstmate(false);
    expect((await firstmate("hello")).text).toBe(MOCK_FM_CHAT_TEXT);
  });

  it("cuts the first mate's Claude seat with each class's typed refusal, and only that seat", async () => {
    const provider = await start();
    const claudeTurn = () =>
      post("anthropic", {
        system: FIRSTMATE_PERSONA,
        messages: [user("anthropic", turn("hello"))],
      });
    provider.cutClaudeSeat({ class: "signed_out" });
    const signedOut = await claudeTurn();
    expect(signedOut.status).toBe(401);
    expect((await signedOut.json()).error.type).toBe("authentication_error");
    const resetsAt = Date.UTC(2026, 10, 5, 18, 0);
    provider.cutClaudeSeat({ class: "no_headroom", resetsAt });
    const limited = await claudeTurn();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.type).toBe("rate_limit_error");
    expect(limited.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
    expect(limited.headers.get("anthropic-ratelimit-unified-reset")).toBe(String(resetsAt / 1000));
    expect(limited.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe(
      "five_hour",
    );
    provider.cutClaudeSeat({ class: "refused" });
    const refused = await claudeTurn();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.type).toBe("permission_error");
    // A seat on another wire, and any crewmate, still answer.
    expect((await firstmate("hello")).text).toBe(MOCK_FM_CHAT_TEXT);
    expect((await ask("anthropic", { messages: [user("anthropic", "hello")] })).status).toBe(200);
    provider.cutClaudeSeat(null);
    expect((await claudeTurn()).status).toBe(200);
  });
});

describe("the first mate holding its turn open for a steer", () => {
  const sent = (...messages: unknown[]): Sent => ({
    system: FIRSTMATE_PERSONA,
    tools: [`${CLAUDE_SEAT_TOOL_PREFIX}crew_status`, `${CLAUDE_SEAT_TOOL_PREFIX}emit_card`],
    messages,
  });
  const look = user("anthropic", turn(FM_SEAT_HOLD_MARKER));
  const status: SentCall = { name: `${CLAUDE_SEAT_TOOL_PREFIX}crew_status`, args: {} };

  it("looks at the crew, holds the next leg open, and looks again once released", async () => {
    const provider = await start();
    expect(names(await ask("anthropic", sent(look)))).toEqual([
      `${CLAUDE_SEAT_TOOL_PREFIX}crew_status`,
    ]);
    const response = await post("anthropic", sent(look, ...loop("anthropic", [status])));
    expect(provider.heldFirstmate()).toBe(1);
    expect(provider.heldRequests()).toBe(0);
    provider.releaseHeldFirstmate();
    expect(answerOf("anthropic", sse(await response.text())).calls).toEqual([
      { name: `${CLAUDE_SEAT_TOOL_PREFIX}crew_status`, args: {} },
    ]);
    expect(provider.heldFirstmate()).toBe(0);
  });

  it("answers the steer with its card, then closes the loop", async () => {
    await start();
    const steer = user("anthropic", turn(FM_SEAT_STEER_WORD));
    const card = await ask("anthropic", sent(look, ...loop("anthropic", [status]), steer));
    expect(card.calls).toEqual([
      {
        name: `${CLAUDE_SEAT_TOOL_PREFIX}emit_card`,
        args: { title: FM_SEAT_STEERED_TITLE, body: expect.any(String) },
      },
    ]);
    const done = await ask(
      "anthropic",
      sent(look, steer, ...loop("anthropic", [{ name: "emit_card", args: {} }])),
    );
    expect(done).toMatchObject({ calls: [], text: "Done." });
  });
});

describe("the kind classifier", () => {
  it.each([
    [RETRIEVAL_TASK_GOAL, "retrieval"],
    [SEQ_REPRODUCE_GOAL, "reproduce"],
    [CLASSIFY_CHORE_MARKER, "chore"],
    [MOCK_FOLLOWUP_TITLE, "research"],
    ["Fix the gauge", "unclear"],
  ])("sorts %j as %s", async (work, kind) => {
    await start();
    const answer = await ask("chat", {
      system: KIND_CLASSIFIER_OPENING,
      messages: [user("chat", work)],
    });
    expect(answer).toMatchObject({ calls: [], text: kind });
  });
});

describe("the first mate's answer-delivery retry", () => {
  it.each([
    [ANSWER_MISSING_OPENING, RETRY_SILENT_MARKER, []],
    [ANSWER_MISSING_OPENING, RETRY_ACTS_MARKER, ["create_task"]],
    [ANSWER_MISSING_ENDED_OPENING, SILENT_ANSWER_MARKER, ["emit_card"]],
    [ANSWER_MISSING_OPENING, "the captain's own words", ["emote"]],
  ])("after %j quoting %j answers with %j", async (opening, words, calls) => {
    await start();
    const answer = await ask("chat", {
      system: FIRSTMATE_PERSONA,
      messages: [user("chat", `${opening}: "${words}"`)],
    });
    expect(names(answer)).toEqual(calls);
    if (calls.length === 0) expect(answer.text).toBe(MOCK_FM_DONE_TEXT);
    if (calls[0] === "create_task")
      expect(answer.calls[0]?.args).toMatchObject({ user_words: RETRY_ACTS_MARKER });
    if (calls[0] === "emit_card")
      expect(answer.calls[0]?.args).toMatchObject({ title: RETRY_ANSWER_TITLE });
    if (calls[0] === "emote") expect(answer.calls[0]?.args).toEqual({ emote: "nod" });
  });

  it("closes the retry's tool loop briefly", async () => {
    await start();
    const answer = await ask("chat", {
      system: FIRSTMATE_PERSONA,
      messages: [
        user("chat", `${ANSWER_MISSING_OPENING}: "${SILENT_ANSWER_MARKER}"`),
        ...loop("chat", [{ name: "emote", args: { emote: "nod" } }]),
      ],
    });
    expect(answer).toMatchObject({ calls: [], text: MOCK_FM_DONE_TEXT });
  });

  it("reacts to the captain's words, or answers them with closing words only", async () => {
    await start();
    const react = await firstmate(REACT_PROMPT_MARKER);
    expect(react.calls).toEqual([{ name: "emote", args: { emote: "nod" } }]);
    const silent = await firstmate(SILENT_ANSWER_MARKER);
    expect(silent.calls).toEqual([]);
    expect(silent.text).not.toBe("");
    expect(silent.text).not.toBe(MOCK_FM_CHAT_TEXT);
  });
});

describe("the first mate's shared commands", () => {
  const crew = [
    { task_id: "task-old", title: "meter fix", status: "idle" },
    { task_id: "task-gauge", title: "gauge fix", status: "idle" },
  ];

  it.each([
    [
      `${MERGE_PROMPT_MARKER}gauge fix`,
      {
        name: "settle_task",
        args: {
          task_id: "task-gauge",
          mode: "merge-pr",
          closing_sentence: MOCK_CLOSING_SENTENCES["merge-pr"],
        },
      },
    ],
    [
      `${LAND_PROMPT_MARKER}gauge fix`,
      {
        name: "settle_task",
        args: {
          task_id: "task-gauge",
          mode: "land",
          closing_sentence: MOCK_CLOSING_SENTENCES.land,
        },
      },
    ],
    [
      `${DISCARD_PROMPT_MARKER}meter fix`,
      {
        name: "settle_task",
        args: {
          task_id: "task-old",
          mode: "discard",
          closing_sentence: MOCK_CLOSING_SENTENCES.discard,
        },
      },
    ],
    [
      `${CANCEL_PROMPT_MARKER}gauge fix`,
      {
        name: "interrupt_crewmate",
        args: {
          task_id: "task-gauge",
          mode: "cancel",
          closing_sentence: MOCK_CLOSING_SENTENCES.cancel,
        },
      },
    ],
    [
      `${STEER_PROMPT_MARKER}gauge fix: read the flush first`,
      { name: "steer_crewmate", args: { task_id: "task-gauge", message: "read the flush first" } },
    ],
    [
      `${STEER_PROMPT_MARKER}gauge fix`,
      { name: "steer_crewmate", args: { task_id: "task-gauge", message: "carry on" } },
    ],
    [
      `${LAND_PROMPT_MARKER}hull fix`,
      {
        name: "settle_task",
        args: { task_id: "missing", mode: "land", closing_sentence: MOCK_CLOSING_SENTENCES.land },
      },
    ],
  ])("%j", async (words, call) => {
    await start();
    expect((await firstmate(words, [], crew)).calls).toEqual([call]);
  });

  it("settles a finished answer task by the id its report names", async () => {
    await start();
    const wake = frameServedInput([
      {
        kind: "wake",
        origin: "crewmate-report",
        body: `[fm-op] crewmate 1 reported on task task-gauge. ${FINISHED_REPORT_WORDS}.`,
      },
    ]).text;
    const answer = await ask("chat", { system: FIRSTMATE_PERSONA, messages: [user("chat", wake)] });
    expect(answer.calls).toEqual([
      { name: "settle_task", args: { task_id: "task-gauge", mode: "done", why: "answered" } },
    ]);
  });

  it("does not re-run the captain's words on a tool loop's leg: it closes the loop", async () => {
    await start();
    const words = `${LAND_PROMPT_MARKER}gauge fix`;
    const answer = await ask("chat", {
      system: FIRSTMATE_PERSONA,
      messages: [
        user("chat", turn(words, crew)),
        ...loop("chat", [{ name: "settle_task", args: {} }]),
      ],
    });
    expect(answer).toMatchObject({ calls: [], text: MOCK_FM_DONE_TEXT });
    expect(await firstmate("hello", [], crew)).toMatchObject({
      calls: [],
      text: MOCK_FM_CHAT_TEXT,
    });
  });

  it("welcomes a captain new to cards with one standalone note", async () => {
    await start();
    const wake = frameServedInput([
      { kind: "wake", origin: "agent", body: `The captain ${WELCOME_WAKE_WORDS}.` },
    ]).text;
    const answer = await ask("chat", { system: FIRSTMATE_PERSONA, messages: [user("chat", wake)] });
    expect(answer.calls).toEqual([
      {
        name: "emit_card",
        args: { title: expect.any(String), body: expect.stringContaining("<p>") },
      },
    ]);
  });

  it("answers with a card, a tall one on the tall words", async () => {
    await start();
    expect((await firstmate(ANSWER_PROMPT_MARKER)).calls).toEqual([
      {
        name: "emit_card",
        args: { title: MOCK_ANSWER_TITLE, body: MOCK_ANSWER_TEXT },
      },
    ]);
    expect((await firstmate(TALL_ANSWER_PROMPT_MARKER)).calls[0]?.args).toMatchObject({
      body: MOCK_ANSWER_TEXT.repeat(100),
    });
  });

  it("changes the catalog the captain's words name", async () => {
    await start();
    const change = { action: "use", catalog: "integrations", name: "github" };
    expect(
      (await firstmate(`${APP_CATALOG_PROMPT_MARKER}${JSON.stringify(change)}`)).calls,
    ).toEqual([
      {
        name: "app_change",
        args: { ...change, on_words: true, evidence: "captain requested catalog change" },
      },
    ]);
  });
});

describe("the first mate's spawn", () => {
  const repos = [{ name: "meterlab", repo_id: "repo-meter" }];
  const spawned = async (title: string) => {
    await start();
    const answer = await firstmate(`${SPAWN_PROMPT_MARKER} ${title}`, [], [], repos);
    expect(names(answer)).toEqual(["spawn_crewmate"]);
    return answer.calls[0]?.args as Record<string, unknown>;
  };

  it("asks for a quick crewmate on the words' title, bound to the project they name", async () => {
    expect(await spawned("fix the meterlab gauge")).toEqual({
      title: "fix the meterlab gauge",
      goal: 'Complete the task "fix the meterlab gauge" and report the outcome.',
      user_words: "commission a crewmate: fix the meterlab gauge",
      repo_id: "repo-meter",
      shape: { rigor_ask: "quick" },
    });
  });

  it.each([
    [REVIEWED_TIER_PROMPT_MARKER, { shape: { rigor_ask: "reviewed" } }],
    [STANDARD_TIER_PROMPT_MARKER, { shape: { rigor_ask: "standard" } }],
    [STANDARD_TIER_HOST_BUTTONS_MARKER, { shape: { rigor_ask: "standard" } }],
    [REVIEW_CAREFULLY_MARKER, { shape: { rigor_ask: "standard" } }],
    [AUTONOMY_ASK_MARKER, { shape: { autonomy_ask: true, rigor_ask: "quick" } }],
    [
      CLAUDE_CREW_PROMPT_MARKER,
      { shape: { override_model_id: CLAUDE_CREW_MODEL, rigor_ask: "quick" } },
    ],
    [WRITE_ASK_ANSWER_MARKER, { constraints: [{ kind: "read-only" }] }],
    [THREAD_TREE_PROMPT_MARKER, { parent: THREAD_TREE_PARENT_KEY }],
  ])("reads %j in the title", async (marker, shape) => {
    expect(await spawned(`gauge ${marker}`)).toMatchObject(shape);
  });
});

describe("the panel-building crewmate", () => {
  const BRIEF = `${BUILD_IN_PLACE_OPENING}: a Tokyo clock panel on the rail.`;

  /** Runs the crewmate's turns on Pi's wire, each answer's calls answered, until it reports. */
  async function build(brief: string) {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const provider = await start();
    const messages: unknown[] = [user("chat", brief)];
    const steps: string[][] = [];
    for (let step = 0; step < 10; step += 1) {
      const read = nextRequest(provider);
      const pending = ask("chat", { messages });
      await read;
      await vi.advanceTimersByTimeAsync(60_000);
      const answer = await pending;
      if (answer.calls.length === 0) return { steps, last: answer };
      steps.push(names(answer));
      messages.push(...loop("chat", answer.calls as ScriptedCall[]));
    }
    throw new Error("the crewmate never stopped");
  }

  it("writes, checks, places and photographs the panel, shows its note, then reports", async () => {
    const { steps, last } = await build(BRIEF);
    expect(steps).toEqual([
      ["write", "write", "note_progress"],
      ["lint_panel", "capture_panel"],
      ["place_panel"],
      ["capture_panel"],
      ["emit_card"],
      ["report"],
    ]);
    expect(last.text).toBe("done");
  });

  it("names the panel's files and its note and report", async () => {
    await start();
    const first = await ask("chat", { messages: [user("chat", BRIEF)] });
    expect(first.calls.map((call) => (call.args as { path?: string }).path)).toEqual([
      `${MOCK_PANEL_ID}/panel.tsx`,
      `${MOCK_PANEL_ID}/manifest.json`,
      undefined,
    ]);
    expect(JSON.parse((first.calls[1]!.args as { content: string }).content)).toEqual({
      title: "Tokyo clock",
      reads: ["feed.recent"],
    });
    const done = ["write", "lint_panel", "place_panel", "capture_panel", "capture_panel"].map(
      (name) => ({
        name,
        args: { id: MOCK_PANEL_ID },
      }),
    ) as ScriptedCall[];
    const note = await ask("chat", { messages: [user("chat", BRIEF), ...loop("chat", done)] });
    expect(note.calls).toEqual([
      {
        name: "emit_card",
        args: {
          title: MOCK_PANEL_NOTE_TITLE,
          answering: true,
          body: expect.stringContaining(MOCK_PANEL_REPORT),
        },
      },
    ]);
  });

  it("rewrites the panel with smaller rows on the change brief, then reports the change", async () => {
    const { steps } = await build(`${BRIEF} Make its rows smaller.`);
    expect(steps).toEqual([
      ["write"],
      ["capture_panel"],
      ["place_panel"],
      ["capture_panel"],
      ["emit_card"],
      ["report"],
    ]);
  });

  it("reports the change in its own words", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const provider = await start();
    const done = ["write", "capture_panel", "place_panel", "capture_panel", "emit_card"].map(
      (name) => ({
        name,
        args: {},
      }),
    ) as ScriptedCall[];
    const read = nextRequest(provider);
    const pending = ask("chat", {
      messages: [user("chat", `${BRIEF} Make its rows smaller.`), ...loop("chat", done)],
    });
    await read;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).calls).toEqual([
      { name: "report", args: { text: MOCK_PANEL_REVISED_REPORT } },
    ]);
  });
});

describe("the crewmate that keeps a thread", () => {
  const BRIEF = user("chat", `Fix the flaky test and ${THREAD_PROMPT_MARKER}.`);
  const SHOWN = loop(
    "chat",
    [{ name: "emit_card", args: { id: "thread-card" } }],
    "Card shown: Two ways (card-thread-1)",
  );
  const reply = (words: string, message = 7) =>
    user("chat", `This is the captain's message ${message} about the card: ${words}`);

  it("shows its decision card, then holds for the captain", async () => {
    await start();
    const card = await ask("chat", { messages: [BRIEF] });
    expect(card.calls).toEqual([
      {
        name: "emit_card",
        args: {
          id: "thread-card",
          title: THREAD_CARD_TITLE,
          body: expect.any(String),
          actions: [
            { id: "mock-clock", label: "Mock the clock" },
            { id: "await-queue", label: "Await the queue", default: true },
          ],
        },
      },
    ]);
    expect(await ask("chat", { messages: [BRIEF, ...SHOWN] })).toMatchObject({
      calls: [],
      text: expect.stringContaining("holding"),
    });
  });

  it("revises the card on words that change it, and answers in the thread on words that do not", async () => {
    await start();
    const revise = await ask("chat", { messages: [BRIEF, ...SHOWN, reply(THREAD_REVISE_REPLY)] });
    expect(revise.calls).toEqual([
      {
        name: "emit_card",
        args: expect.objectContaining({
          id: "thread-card",
          title: THREAD_CARD_REVISED_TITLE,
          reply: THREAD_REVISE_ANSWER,
          answers_message: 7,
        }),
      },
    ]);
    const prose = await ask("chat", { messages: [BRIEF, ...SHOWN, reply(THREAD_PROSE_REPLY, 8)] });
    expect(prose.calls).toEqual([
      {
        name: "reply",
        args: { card_id: "card-thread-1", text: THREAD_PROSE_ANSWER, answers_message: 8 },
      },
    ]);
  });

  it("acknowledges, holds its answer until released, then revises and reports", async () => {
    const provider = await start();
    const ack = reply(THREAD_ACK_REPLY, 9);
    const first = await ask("chat", { messages: [BRIEF, ...SHOWN, ack] });
    expect(first.calls).toEqual([
      { name: "reply", args: { card_id: "card-thread-1", text: THREAD_ACK_TEXT } },
    ]);
    const acked = [BRIEF, ...SHOWN, ack, ...loop("chat", first.calls as ScriptedCall[])];
    const read = nextRequest(provider);
    const held = ask("chat", { messages: acked });
    await read;
    expect(provider.heldThreadAnswers()).toBe(1);
    provider.releaseThreadAnswer();
    const revision = await held;
    expect(provider.heldThreadAnswers()).toBe(0);
    expect(revision.calls).toEqual([
      {
        name: "emit_card",
        args: expect.objectContaining({
          id: "thread-card",
          title: THREAD_ACK_REVISED_TITLE,
          reply: THREAD_ACK_ANSWER,
          answers_message: 9,
        }),
      },
    ]);
    const revised = [...acked, ...loop("chat", revision.calls as ScriptedCall[])];
    expect(names(await ask("chat", { messages: revised }))).toEqual(["report"]);
    const reported = [...revised, ...loop("chat", [{ name: "report", args: {} }])];
    expect(await ask("chat", { messages: reported })).toMatchObject({
      calls: [],
      text: "Answered on the card.",
    });
  });
});

describe("the Claude crewmate on a refused login", () => {
  const brief = (more = "") =>
    user("anthropic", `Count the rivets ${CLAUDE_REFUSED_PROMPT_MARKER}. ${more}`);

  it("is refused while the server refuses, then answers", async () => {
    const provider = await start();
    const refused = await post("anthropic", { messages: [brief()] });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.type).toBe("permission_error");
    provider.refuseClaude(false);
    expect(await ask("anthropic", { messages: [brief()] })).toMatchObject({
      calls: [],
      text: "Nothing new to add.",
    });
    expect(
      (
        await ask("anthropic", {
          messages: [brief(), user("anthropic", CLAUDE_REFUSAL_OVER_MARKER)],
        })
      ).calls,
    ).toEqual([{ name: "report", args: { text: MOCK_CLAUDE_REFUSAL_OVER_REPORT } }]);
    const leg = await ask("anthropic", {
      messages: [brief(), ...loop("anthropic", [{ name: "report", args: {} }])],
    });
    expect(leg).toMatchObject({ calls: [], text: "done" });
  });

  it("shows its chart card, then answers the captain's reply in the card's thread", async () => {
    const provider = await start();
    provider.refuseClaude(false);
    const chart = await ask("anthropic", { messages: [brief(CLAUDE_HELD_CARD_MARKER)] });
    expect(chart.calls).toEqual([
      { name: "emit_card", args: { title: MOCK_CLAUDE_HELD_CARD_TITLE, body: expect.any(String) } },
    ]);
    const answer = await ask("anthropic", {
      messages: [
        brief(CLAUDE_HELD_CARD_MARKER),
        { role: "assistant", content: [{ type: "text", text: "Shown." }] },
        user(
          "anthropic",
          `This is the captain's message 4 about Reef chart (card-reef-1): ${CLAUDE_HELD_REPLY}`,
        ),
      ],
    });
    expect(answer.calls).toEqual([
      {
        name: "reply",
        args: { card_id: "card-reef-1", text: MOCK_CLAUDE_HELD_ANSWER, answers_message: 4 },
      },
    ]);
  });
});

describe("the Claude crewmate", () => {
  const brief = (more = "") =>
    user("anthropic", `Count the rivets ${CLAUDE_CREW_PROMPT_MARKER}. ${more}`);
  const tools = [
    `${CLAUDE_SEAT_TOOL_PREFIX}emit_card`,
    `${CLAUDE_SEAT_TOOL_PREFIX}report`,
    `${CLAUDE_SEAT_TOOL_PREFIX}note_progress`,
  ];

  it("shows its card, holds its next step until released, and reports on the steer", async () => {
    const provider = await start();
    const card = await ask("anthropic", { messages: [brief()], tools });
    expect(card.calls).toEqual([
      {
        name: `${CLAUDE_SEAT_TOOL_PREFIX}emit_card`,
        args: { title: MOCK_CLAUDE_CARD_TITLE, body: expect.any(String) },
      },
    ]);
    const shown = [brief(), ...loop("anthropic", [{ name: "emit_card", args: {} }])];
    const response = await post("anthropic", { messages: shown, tools });
    expect(provider.heldRequests()).toBe(1);
    provider.releaseHeldCrew();
    expect(answerOf("anthropic", sse(await response.text())).calls).toEqual([
      {
        name: `${CLAUDE_SEAT_TOOL_PREFIX}note_progress`,
        args: { text: MOCK_CLAUDE_HELD_PROGRESS },
      },
    ]);
    const steered = await ask("anthropic", {
      messages: [...shown, user("anthropic", CLAUDE_STEER_MARKER)],
      tools,
    });
    expect(steered.calls).toEqual([
      { name: `${CLAUDE_SEAT_TOOL_PREFIX}report`, args: { text: MOCK_CLAUDE_STEERED_REPORT } },
    ]);
    const closed = await ask("anthropic", {
      messages: [
        ...shown,
        user("anthropic", CLAUDE_STEER_MARKER),
        ...loop("anthropic", [{ name: "report", args: {} }]),
      ],
      tools,
    });
    expect(closed).toMatchObject({ calls: [], text: "done" });
  });

  it("offers a choice and reports its progress when its card is to retire", async () => {
    await start();
    const card = await ask("anthropic", { messages: [brief(CLAUDE_CARD_RETIRE_MARKER)] });
    expect(card.calls).toEqual([
      {
        name: "emit_card",
        args: {
          title: MOCK_CLAUDE_CARD_TITLE,
          body: expect.any(String),
          actions: [
            { id: "port", label: "Inspect the port hatch", default: true },
            { id: "starboard", label: "Inspect the starboard hatch" },
          ],
        },
      },
      { name: "report", args: { text: MOCK_CLAUDE_HELD_PROGRESS } },
    ]);
  });
});
