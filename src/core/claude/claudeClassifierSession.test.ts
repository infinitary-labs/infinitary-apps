import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedClaudeQuery as scriptedQuery } from "../../../tests/helpers/scriptedClaudeQuery";
import { questionSessionSpec } from "../decisions/questionSession";
import { CLASSIFIER_MAX_OUTPUT_TOKENS } from "../orchestrator/seat";
import type { ModelSession, SessionEvent } from "../session/session";
import type { BoundTool } from "../session/tools";
import type { ClaudeClientCheck } from "./claudeCli";
import type { ClaudeRateLimit } from "./claudeEvents";
import { CLAUDE_MODELS } from "./claudeModels";
import { CLAUDE_MODEL_PROVIDER, type ClaudeQueryFactory } from "./claudeQueryCore";
import { hasActiveSession, resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

/**
 * The Claude classifier (W1 S10) - the question's one-shot session on
 * Claude's session factory - against a scripted client that speaks the
 * message shapes the real one does: the one query it makes, what it reads
 * off the one result, a typed failure, the caller's bound, and the store
 * lease it holds for its whole life. The real client's side of the same
 * contract is `claudeClassifierSession.integration.test.ts`.
 */

const CONFIG_DIR = "/home/person/.claude";
const MODEL = "claude-haiku-4-5";
const READY: ClaudeClientCheck = { state: "ready", executable: "/usr/local/bin/claude" };

const spec = questionSessionSpec({
  homeDir: "/tmp/fm-home",
  binding: { backend: "claude", accountId: "acct_claude" },
  model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
  instruction: "Answer with exactly one of: left, right.",
});

/** One result message as the client sends it: the answer and its cumulative usage. */
function result(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: 0.001,
    modelUsage: {
      [MODEL]: {
        inputTokens: 300,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    ...overrides,
  };
}

function factoryWith(
  query: ClaudeQueryFactory,
  extras: {
    check?: ClaudeClientCheck;
    readings?: ClaudeRateLimit[];
  } = {},
) {
  return createClaudeSessionFactory({
    configDir: CONFIG_DIR,
    env: () => ({
      PATH: "/usr/bin",
      HOME: "/home/person",
      ANTHROPIC_API_KEY: "ambient",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(CLASSIFIER_MAX_OUTPUT_TOKENS),
    }),
    checkClient: async () => extras.check ?? READY,
    query,
    ...(extras.readings
      ? { onRateLimit: (_accountId, reading) => extras.readings?.push(reading) }
      : {}),
  });
}

function recorder(session: ModelSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

afterEach(() => {
  resetStoreLeasesForTest();
});

describe("the Claude classifier session", () => {
  it("makes one query: the instruction as the whole prompt, no tools, one turn, no transcript", async () => {
    const { factory, attachments, harness } = scriptedQuery({
      onInput: (_message, emit) => emit(result("left")),
    });
    const session = await factoryWith(factory).open(spec);
    // Nothing is spawned until the question is asked.
    expect(attachments).toHaveLength(0);
    await session.prompt("Which way?");
    expect(attachments).toHaveLength(1);
    const options = harness().options;
    expect(options).toMatchObject({
      cwd: "/tmp/fm-home",
      systemPrompt: "Answer with exactly one of: left, right.",
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 1,
      effort: "low",
      // INF-1451: low effort, but no claim that every model can disable thinking.
      // The typed stop of a request rides its streamed `message_delta`.
      includePartialMessages: true,
      persistSession: false,
      model: MODEL,
    });
    // INF-1451: hidden thinking must not consume an answer-only cap, even
    // when the shell that started the session had that cap set.
    expect(options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(options.env).toHaveProperty("CLAUDE_CODE_MAX_OUTPUT_TOKENS", undefined);
    expect(options.thinking).toBeUndefined();
    // Not the person's servers, notes or ambient credentials: the machine's default login only.
    expect(options.mcpServers).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(options.env?.MAX_MCP_OUTPUT_TOKENS).toBeUndefined();
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_ENTRYPOINT).toBe("infinitary");
    expect(harness().inputs.map((input) => input.message.content)).toEqual(["Which way?"]);
    session.dispose();
  });

  it("reports the one answer as closing words, with the turn's usage", async () => {
    const { factory } = scriptedQuery({ onInput: (_message, emit) => emit(result(" right\n")) });
    const session = await factoryWith(factory).open(spec);
    const events = recorder(session);
    await session.prompt("Which way?");
    expect(events).toEqual([
      {
        type: "turn_end",
        taskId: "firstmate",
        usage: expect.objectContaining({ input: 300, output: 2 }),
      },
      { type: "turn_closed", text: "right" },
    ]);
    expect(session.modelRef()).toEqual({ provider: CLAUDE_MODEL_PROVIDER, id: MODEL });
    session.dispose();
  });

  it("carries a typed cut-off on the failed turn, never the client's words as a class", async () => {
    const { factory } = scriptedQuery({
      onInput: (_message, emit) => {
        emit({ type: "assistant", message: { content: [] }, error: "oauth_org_not_allowed" });
        emit(result("Your organization does not allow this.", { is_error: true }));
      },
    });
    const session = await factoryWith(factory).open(spec);
    const events = recorder(session);
    await session.prompt("Which way?");
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([
      {
        type: "turn_failed",
        taskId: "firstmate",
        error: "Your organization does not allow this.",
        cutOff: { class: "refused" },
      },
    ]);
    // A failed turn has no answer to close with.
    expect(events.at(-1)).toEqual({ type: "turn_closed" });
    session.dispose();
  });

  it("passes the plan-window readings the client pushes to the account's quota", async () => {
    const readings: ClaudeRateLimit[] = [];
    const { factory } = scriptedQuery({
      onInput: (_message, emit) => {
        emit({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            utilization: 0.4,
            resetsAt: 1_800_000_000,
            rateLimitType: "five_hour",
          },
        });
        emit(result("left"));
      },
    });
    const session = await factoryWith(factory, { readings }).open(spec);
    await session.prompt("Which way?");
    expect(readings).toEqual([
      { status: "allowed", utilization: 0.4, resetsAt: 1_800_000_000_000, windowId: "five_hour" },
    ]);
    session.dispose();
  });

  it("labels its model by the catalog's name, and has none for a model the catalog does not name (INF-2625's guardrail)", async () => {
    const { factory } = scriptedQuery({ onInput: () => {} });
    // The pair is the shipped catalog's (claudeModelCatalog.test.ts owns its names).
    const haiku = CLAUDE_MODELS.find((model) => model.id.includes("haiku"));
    if (!haiku) throw new Error("the shipped catalog names no Haiku model");
    const named = await factoryWith(factory).open({
      ...spec,
      model: { provider: CLAUDE_MODEL_PROVIDER, id: haiku.id },
    });
    expect(named.modelLabel()).toBe(haiku.name);
    named.dispose();
    const unnamed = await factoryWith(factory).open(spec);
    expect(unnamed.modelRef()).toEqual({ provider: CLAUDE_MODEL_PROVIDER, id: MODEL });
    expect(unnamed.modelLabel()).toBeUndefined();
    unnamed.dispose();
  });

  it("speaks the spec's tools by their bare names (INF-2625's guardrail)", async () => {
    const { factory } = scriptedQuery({
      onInput: (_message, emit) => {
        emit({
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "tool_use", id: "call-1", name: "mcp__infinitary__lookup", input: {} },
            ],
          },
        });
        emit({
          type: "user",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false }] },
        });
        emit(result("left"));
      },
    });
    const lookup: BoundTool = {
      name: "lookup",
      label: "lookup",
      description: "Look a word up.",
      parameters: Type.Object({ word: Type.String() }),
      run: async () => ({ text: "found" }),
    };
    const session = await factoryWith(factory).open({ ...spec, tools: [lookup] });
    const events = recorder(session);
    await session.prompt("Which way?");
    expect(
      events.flatMap((event) =>
        event.type === "tool_start" || event.type === "tool_end" ? [event.toolName] : [],
      ),
    ).toEqual(["lookup", "lookup"]);
    session.dispose();
  });

  it("gives the question up at once on abort, and stops the client", async () => {
    const { factory, harness } = scriptedQuery({ onInput: () => {} });
    const session = await factoryWith(factory).open(spec);
    const asked = session.prompt("Which way?");
    await session.abort();
    await asked;
    expect(harness().closed()).toBe(true);
    session.dispose();
    // The stopped client's stream ends, and with it the hold on the store.
    await expect.poll(() => hasActiveSession(CONFIG_DIR)).toBe(false);
  });

  it("fails the question when the client stops before it answers", async () => {
    const { factory, harness } = scriptedQuery({ onInput: () => {} });
    const session = await factoryWith(factory).open(spec);
    const asked = session.prompt("Which way?");
    harness().fail(new Error("the client exited with code 1"));
    await expect(asked).rejects.toThrow("the client exited with code 1");
    session.dispose();
    await expect.poll(() => hasActiveSession(CONFIG_DIR)).toBe(false);
  });

  it("still honors an explicit output cap and stops the client asking again", async () => {
    // The client hands over the message before the request's typed stop,
    // which rides the streamed `message_delta`; its own recovery would then
    // ask for the rest.
    const { factory, harness } = scriptedQuery({
      onInput: (_message, emit) => {
        emit({
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "message_start", message: { usage: { input_tokens: 300 } } },
        });
        emit({
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "chore - a dependency bump, so" }] },
        });
        emit({
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 64 },
          },
        });
        // Already on its way when the client is stopped: not a second answer.
        emit(result("unclear", { is_error: true }));
      },
    });
    const session = await factoryWith(factory).open({
      ...spec,
      bounds: {
        request: { ...spec.bounds?.request, maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS },
      },
    });
    const events = recorder(session);
    await session.prompt("Which way?");
    expect(harness().options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(
      String(CLASSIFIER_MAX_OUTPUT_TOKENS),
    );
    expect(harness().options.thinking).toEqual({ type: "disabled" });
    expect(events.filter((event) => event.type !== "assistant_delta")).toEqual([
      { type: "turn_end", taskId: "firstmate", usage: { input: 300, output: 64 } },
      { type: "turn_closed", text: "chore - a dependency bump, so" },
    ]);
    expect(harness().closed()).toBe(true);
    session.dispose();
    await expect.poll(() => hasActiveSession(CONFIG_DIR)).toBe(false);
    expect(events.filter((event) => event.type === "turn_closed")).toHaveLength(1);
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
  });
});

describe("the Claude classifier's hold on the login's store", () => {
  it("holds the shared lease from creation until the client has exited", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: (_message, emit) => emit(result("left")),
    });
    const session = await factoryWith(factory).open(spec);
    expect(hasActiveSession(CONFIG_DIR)).toBe(true);
    await session.prompt("Which way?");
    session.dispose();
    // The answered client ends its input and exits on its own; the store is free.
    await expect.poll(() => harness().closed()).toBe(true);
    await expect.poll(() => hasActiveSession(CONFIG_DIR)).toBe(false);
  });

  it("hands the store back when disposed before any question", async () => {
    const { factory } = scriptedQuery({ onInput: () => {} });
    const session = await factoryWith(factory).open(spec);
    session.dispose();
    expect(hasActiveSession(CONFIG_DIR)).toBe(false);
  });

  it("refuses with the client's sentence, taking no lease, when the client is gone", async () => {
    const { factory, attachments } = scriptedQuery({ onInput: () => {} });
    await expect(factoryWith(factory, { check: { state: "missing" } }).open(spec)).rejects.toThrow(
      /Claude/,
    );
    expect(hasActiveSession(CONFIG_DIR)).toBe(false);
    expect(attachments).toHaveLength(0);
  });
});
