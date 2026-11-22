import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime, ToolDefinition } from "./types";

/**
 * The Firstmate session contract test: pins the exact production call shape
 * into Pi's createAgentSession for the orchestrator session, exactly as the
 * crewmate realSession test pins the crewmate's. The load-bearing pins: the
 * built-ins are disabled with noTools "builtin" (the agent structurally
 * cannot reach Pi's builtins), no `tools` allowlist is passed (custom tools are
 * enabled without one under noTools "builtin"), and the fixed model is
 * resolved through the runtime and fails loudly when unknown.
 */

const piMocks = vi.hoisted(() => {
  const sessionEntries = (entries: unknown[]) => ({
    entries,
    getEntries: () => entries,
    getBranch: () => entries,
    appendCustomEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    }),
  });
  const agentSession = {
    sessionId: "fm-session-1",
    sessionFile: "/tmp/firstmate/sessions/session.jsonl",
    isStreaming: false,
    messages: [] as unknown[],
    model: { provider: "fm-mock", id: "mock-1", contextWindow: 1_000_000 },
    settingsManager: {
      applyOverrides: vi.fn((_settings: { compaction?: { reserveTokens?: number } }) => {}),
    },
    subscribe: vi.fn((_listener: (event: unknown) => void) => () => {}),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    getActiveToolNames: vi.fn(() => ["emit_card"]),
    setActiveToolsByName: vi.fn(),
    sessionManager: sessionEntries([]),
  };
  return {
    agentSession,
    sessionEntries,
    createAgentSession: vi.fn(async () => ({ session: agentSession })),
    sessionManagerCreate: vi.fn(() => ({ kind: "created", ...sessionEntries([]) })),
    sessionManagerOpen: vi.fn(() => ({ kind: "opened", ...sessionEntries([]) })),
    settingsInMemory: vi.fn(() => ({ kind: "settings" })),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: piMocks.createAgentSession,
    SessionManager: {
      create: piMocks.sessionManagerCreate,
      open: piMocks.sessionManagerOpen,
    },
    SettingsManager: { inMemory: piMocks.settingsInMemory },
  };
});

const { FIRSTMATE_CONTRACT_VERSION, firstmatePromptSha, toolsFingerprint } = await import(
  "./piResources"
);
const {
  FIRSTMATE_CAPTAIN_THINKING_LEVEL,
  FIRSTMATE_MAX_MODEL_TURNS,
  FIRSTMATE_OPERATIONAL_THINKING_LEVEL,
  FIRSTMATE_REQUEST_TIMEOUT_MS,
} = await import("../orchestrator/seat");
const { TICK_PERIOD_MS } = await import("../orchestrator/ticker");
const {
  BoundsWatcher,
  modelTurnsErrorMessage,
  requestTimeoutErrorMessage,
  turnTimeoutErrorMessage,
} = await import("../session/bounds");
const { manualClock } = await import("../../../tests/helpers/manualClock");
const {
  createPiSessionFactory,
  FIRSTMATE_CONTRACT_ENTRY,
  PI_PROVIDER_TIMEOUT_MS,
  stripFailedThinking,
} = await import("./session");
const { seatSpec } = await import("../../../tests/helpers/seatSession");

const { boundTool } = await import("../session/tools");

const fakeTool = boundTool({
  name: "emit_card",
  label: "Emit card",
  description: "Show a card",
  parameters: Type.Object({ body: Type.String() }),
  run: ({ body }) => ({ text: `Card accepted: ${body}`, details: { body } }),
});

const spec = {
  cwd: "/tmp/firstmate/home",
  sessionsDir: "/tmp/firstmate/sessions",
  binding: {
    backend: "pi" as const,
    runtime: {
      getModel: vi.fn((provider: string, id: string) =>
        provider === "fm-mock" && id === "mock-1" ? { provider, id, maxTokens: 131072 } : undefined,
      ),
    } as unknown as ModelRuntime,
  },
  model: { provider: "fm-mock", id: "mock-1" },
  tools: [fakeTool],
};

function openSeat(input: Parameters<typeof seatSpec>[0]) {
  return createPiSessionFactory({ agentDir: "/tmp/pi-agent" }).open(seatSpec(input));
}

/**
 * The seat as production opens it: through Pi's factory under the one
 * watcher, on a clock the test moves one tick at a time.
 */
async function openWatchedSeat(input: Parameters<typeof seatSpec>[0]) {
  const clock = manualClock();
  const factory = new BoundsWatcher(clock).factory(
    createPiSessionFactory({ agentDir: "/tmp/pi-agent" }),
  );
  const session = await factory.open(seatSpec(input));
  const ticks = (count: number) => {
    for (let i = 0; i < count; i += 1) clock.advance(TICK_PERIOD_MS);
  };
  return { session, ticks };
}

describe("the served sequences at the session boundary (contract v4.6)", () => {
  it("serves the document from the loader and re-serves a change only between turns", async () => {
    const session = await openSeat({
      ...spec,
      instructions: { text: "# Sequences\none", sha: "sha-one" },
    });
    const options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as {
      resourceLoader: { getAppendSystemPrompt: () => string[] };
    };
    expect(options.resourceLoader.getAppendSystemPrompt()).toEqual(["# Sequences\none"]);
    piMocks.agentSession.setActiveToolsByName.mockClear();

    // Mid-turn: nothing moves; the change waits for the next boundary.
    piMocks.agentSession.isStreaming = true;
    session.serveInstructions?.({ text: "# Sequences\ntwo", sha: "sha-two" });
    expect(options.resourceLoader.getAppendSystemPrompt()).toEqual(["# Sequences\none"]);
    expect(piMocks.agentSession.setActiveToolsByName).not.toHaveBeenCalled();

    // Idle: the loader answers the new text, Pi is asked to rebuild with the
    // same loadout, and the session records the new document's sha.
    piMocks.agentSession.isStreaming = false;
    session.serveInstructions?.({ text: "# Sequences\ntwo", sha: "sha-two" });
    expect(options.resourceLoader.getAppendSystemPrompt()).toEqual(["# Sequences\ntwo"]);
    expect(piMocks.agentSession.setActiveToolsByName).toHaveBeenCalledWith(["emit_card"]);
    expect(piMocks.agentSession.sessionManager.appendCustomEntry).toHaveBeenLastCalledWith(
      FIRSTMATE_CONTRACT_ENTRY,
      {
        version: FIRSTMATE_CONTRACT_VERSION,
        prompt_sha: firstmatePromptSha(),
        instructions_sha: "sha-two",
        tools_sha: toolsFingerprint([fakeTool]),
      },
    );

    piMocks.agentSession.setActiveToolsByName.mockClear();
    session.serveInstructions?.({ text: "# Sequences\ntwo", sha: "sha-two" });
    expect(piMocks.agentSession.setActiveToolsByName).not.toHaveBeenCalled();
  });
});

describe("the Pi seat's production contract", () => {
  it("INF-447: compacts at 300k or earlier and rebudgets at every prompt boundary", async () => {
    const session = await openSeat(spec);
    for (const window of [1_000_000, 200_000, 128_000, 1_000_000]) {
      piMocks.agentSession.model.contextWindow = window;
      await session.prompt("hello");
      const override = piMocks.agentSession.settingsManager.applyOverrides.mock.calls.at(-1)?.[0];
      const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...override?.compaction };
      const trigger = Math.min(300_000, window - DEFAULT_COMPACTION_SETTINGS.reserveTokens);
      expect(shouldCompact(trigger, window, settings)).toBe(false);
      expect(shouldCompact(trigger + 1, window, settings)).toBe(true);
    }
    session.dispose();
  });

  it("creates the rolling session with the pinned call shape", async () => {
    const session = await openSeat(spec);

    expect(piMocks.sessionManagerCreate).toHaveBeenCalledWith(
      "/tmp/firstmate/home",
      "/tmp/firstmate/sessions",
    );
    expect(piMocks.settingsInMemory).toHaveBeenCalledWith({
      compaction: { enabled: true },
      retry: {
        enabled: true,
        maxRetries: 2,
        provider: { timeoutMs: PI_PROVIDER_TIMEOUT_MS },
      },
      defaultThinkingLevel: FIRSTMATE_OPERATIONAL_THINKING_LEVEL,
      enableInstallTelemetry: false,
    });

    const options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(options.cwd).toBe("/tmp/firstmate/home");
    expect(options.agentDir).toBe("/tmp/pi-agent");
    // The orchestrator's per-message output bound (the silence-loop cap):
    // a copy with the clamped maxTokens, never the shared catalog object.
    expect(options.model).toEqual({ provider: "fm-mock", id: "mock-1", maxTokens: 8192 });
    expect(options.thinkingLevel).toBe(FIRSTMATE_OPERATIONAL_THINKING_LEVEL);
    expect(piMocks.agentSession.setThinkingLevel).toHaveBeenCalledWith(
      FIRSTMATE_OPERATIONAL_THINKING_LEVEL,
    );
    // No built-ins, no allowlist: the custom tools are the whole surface.
    expect(options.noTools).toBe("builtin");
    expect("tools" in options).toBe(false);
    // The spec's tools, generated as Pi tools at this factory's boundary:
    // the same words the model reads, running the spec's run.
    const served = options.customTools as ToolDefinition[];
    expect(
      served.map(({ name, label, description, parameters }) => ({
        name,
        label,
        description,
        parameters,
      })),
    ).toEqual([
      {
        name: fakeTool.name,
        label: fakeTool.label,
        description: fakeTool.description,
        parameters: fakeTool.parameters,
      },
    ]);
    await expect(
      served[0]?.execute("call-1", { body: "hi" }, undefined, undefined, {} as never),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Card accepted: hi" }],
      details: { body: "hi" },
    });

    const loader = options.resourceLoader as {
      getSystemPrompt: () => string | undefined;
      getExtensions: () => { extensions: unknown[] };
      getSkills: () => { skills: unknown[] };
      getAgentsFiles: () => { agentsFiles: unknown[] };
    };
    expect(loader.getSystemPrompt()).toContain("You are the first mate aboard Infinitary");
    // Contract v1: the prompt is byte-stable - no interpolated paths; the
    // self-source path rides the context block instead.
    expect(loader.getSystemPrompt()).not.toContain("/tmp/fm-self-source");
    expect(loader.getSystemPrompt()).toContain("self-map.json");
    expect(loader.getSystemPrompt()).toContain("it must not modify that packaged copy");
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);

    await session.prompt("hello");
    expect(piMocks.agentSession.prompt).toHaveBeenCalledWith("hello", { source: "rpc" });

    // Images ride Pi's PromptOptions.images / steer's second argument as
    // flat { type, data, mimeType } parts - never as content arrays in the
    // text position (Pi's prompt() does string work on `text`).
    await session.prompt("see this", [{ mimeType: "image/png", data: "QUJD" }]);
    expect(piMocks.agentSession.prompt).toHaveBeenCalledWith("see this", {
      source: "rpc",
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
    await session.steer("and this", [{ mimeType: "image/jpeg", data: "REVG" }]);
    expect(piMocks.agentSession.steer).toHaveBeenCalledWith("and this", [
      { type: "image", data: "REVG", mimeType: "image/jpeg" },
    ]);
    await session.steer("plain steer");
    expect(piMocks.agentSession.steer).toHaveBeenCalledWith("plain steer", undefined);
  });

  it("records the contract revision and prompt sha in the session, once per prompt (v1.1)", async () => {
    await openSeat(spec);
    const created = piMocks.sessionManagerCreate.mock.results.at(-1)?.value as ReturnType<
      typeof piMocks.sessionEntries
    >;
    expect(created.appendCustomEntry).toHaveBeenCalledWith(FIRSTMATE_CONTRACT_ENTRY, {
      version: FIRSTMATE_CONTRACT_VERSION,
      prompt_sha: firstmatePromptSha(),
      tools_sha: toolsFingerprint([fakeTool]),
    });
    // A resumed session whose newest stamp names this prompt is not re-stamped.
    const resumed = piMocks.sessionEntries([
      {
        type: "custom",
        customType: FIRSTMATE_CONTRACT_ENTRY,
        data: { version: "1", prompt_sha: "old" },
      },
      {
        type: "custom",
        customType: FIRSTMATE_CONTRACT_ENTRY,
        data: {
          version: FIRSTMATE_CONTRACT_VERSION,
          prompt_sha: firstmatePromptSha(),
          tools_sha: toolsFingerprint([fakeTool]),
        },
      },
    ]);
    piMocks.sessionManagerOpen.mockReturnValueOnce({ kind: "opened", ...resumed });
    await openSeat({
      ...spec,
      resume: { backend: "pi", sessionFile: "/tmp/firstmate/sessions/session.jsonl" },
    });
    expect(resumed.appendCustomEntry).not.toHaveBeenCalled();
    // A contract redline is stamped even when its served prompt is unchanged.
    const oldRevision = piMocks.sessionEntries([
      {
        type: "custom",
        customType: FIRSTMATE_CONTRACT_ENTRY,
        data: { version: "2.5", prompt_sha: firstmatePromptSha() },
      },
    ]);
    piMocks.sessionManagerOpen.mockReturnValueOnce({ kind: "opened", ...oldRevision });
    await openSeat({
      ...spec,
      resume: { backend: "pi", sessionFile: "/tmp/firstmate/sessions/session.jsonl" },
    });
    expect(oldRevision.appendCustomEntry).toHaveBeenCalledWith(FIRSTMATE_CONTRACT_ENTRY, {
      version: FIRSTMATE_CONTRACT_VERSION,
      prompt_sha: firstmatePromptSha(),
      tools_sha: toolsFingerprint([fakeTool]),
    });
    // One that last ran an older prompt is.
    const stale = piMocks.sessionEntries([
      {
        type: "custom",
        customType: FIRSTMATE_CONTRACT_ENTRY,
        data: { version: "1", prompt_sha: "old" },
      },
    ]);
    piMocks.sessionManagerOpen.mockReturnValueOnce({ kind: "opened", ...stale });
    await openSeat({
      ...spec,
      resume: { backend: "pi", sessionFile: "/tmp/firstmate/sessions/session.jsonl" },
    });
    expect(stale.appendCustomEntry).toHaveBeenCalledTimes(1);
  });

  it("sets the thinking level a turn asks for (WI-13)", async () => {
    const session = await openSeat(spec);
    piMocks.agentSession.setThinkingLevel.mockClear();
    session.setThinkingLevel?.(FIRSTMATE_CAPTAIN_THINKING_LEVEL);
    expect(piMocks.agentSession.setThinkingLevel).toHaveBeenCalledWith("medium");
    session.setThinkingLevel?.(FIRSTMATE_OPERATIONAL_THINKING_LEVEL);
    expect(piMocks.agentSession.setThinkingLevel).toHaveBeenLastCalledWith("low");
  });

  it("opens the recorded session file when resuming (Q4)", async () => {
    await openSeat({
      ...spec,
      resume: { backend: "pi", sessionFile: "/tmp/existing.jsonl" },
    });
    expect(piMocks.sessionManagerOpen).toHaveBeenCalledWith(
      "/tmp/existing.jsonl",
      "/tmp/firstmate/sessions",
      "/tmp/firstmate/home",
    );
  });

  it("serves only a Pi binding", async () => {
    const created = piMocks.createAgentSession.mock.calls.length;
    await expect(
      openSeat({ ...spec, binding: { backend: "claude", accountId: "acct-claude" } }),
    ).rejects.toThrow(/cannot serve a claude binding/);
    expect(piMocks.createAgentSession.mock.calls.length).toBe(created);
  });

  it("fails loudly on an unknown fixed model instead of falling back", async () => {
    await expect(openSeat({ ...spec, model: { provider: "nope", id: "missing" } })).rejects.toThrow(
      /Unknown model nope\/missing/,
    );
  });

  it("strips thinking from a resumed error turn so it cannot poison the next prompt", async () => {
    piMocks.agentSession.messages = [
      {
        role: "assistant",
        stopReason: "error",
        content: [
          { type: "thinking", thinking: "done. End. Stop looping.", thinkingSignature: "huge" },
          { type: "text", text: "" },
        ],
      },
    ];
    await openSeat(spec);
    expect(piMocks.agentSession.messages).toEqual([
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "" }],
      },
    ]);
  });
});

describe("the seat's bounds", () => {
  const listeners: Array<(event: unknown) => void> = [];

  function emit(event: unknown): void {
    for (const listener of listeners) listener(event);
  }

  beforeEach(() => {
    listeners.length = 0;
    piMocks.agentSession.subscribe.mockImplementation((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    });
    piMocks.agentSession.abort.mockClear();
    piMocks.agentSession.prompt = vi.fn(() => new Promise(() => {}));
  });

  afterEach(() => {
    piMocks.agentSession.subscribe.mockImplementation(
      (_listener: (event: unknown) => void) => () => {},
    );
    piMocks.agentSession.prompt = vi.fn(async () => {});
  });

  it("aborts a single over-budget request and closes the turn as failed", async () => {
    const { session, ticks } = await openWatchedSeat(spec);
    const seen: unknown[] = [];
    session.subscribe((event) => seen.push(event));
    void session.prompt("hello");
    ticks(5);
    expect(piMocks.agentSession.abort).toHaveBeenCalled();
    emit({ type: "turn_end", message: { stopReason: "aborted" } });
    expect(seen).toEqual([
      {
        type: "turn_failed",
        taskId: "firstmate",
        error: requestTimeoutErrorMessage(FIRSTMATE_REQUEST_TIMEOUT_MS),
      },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed" },
    ]);
    session.dispose();
  });

  it("does not abort a multi-request turn whose each request stays under the bound", async () => {
    const { session, ticks } = await openWatchedSeat(spec);
    // Nineteen minutes of work, inside the 20-minute backstop, and no request
    // runs its five.
    void session.prompt("hello");
    ticks(3);
    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "tasks" });
    ticks(5);
    expect(piMocks.agentSession.abort).not.toHaveBeenCalled();
    emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "tasks",
      isError: false,
    });
    ticks(4);
    // The next reply starts its own request.
    emit({ type: "message_start", message: { role: "assistant" } });
    ticks(4);
    emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "emit_card" });
    ticks(3);
    expect(piMocks.agentSession.abort).not.toHaveBeenCalled();
    session.dispose();
  });

  it("aborts a later over-budget request after earlier short ones", async () => {
    const { session, ticks } = await openWatchedSeat(spec);
    void session.prompt("hello");
    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "tasks" });
    ticks(10);
    expect(piMocks.agentSession.abort).not.toHaveBeenCalled();
    emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "tasks",
      isError: false,
    });
    ticks(4);
    expect(piMocks.agentSession.abort).not.toHaveBeenCalled();
    ticks(1);
    expect(piMocks.agentSession.abort).toHaveBeenCalled();
    session.dispose();
  });

  it("reports a cut that lands while a tool runs in the bound's words, not Pi's", async () => {
    const { session, ticks } = await openWatchedSeat(spec);
    const seen: unknown[] = [];
    session.subscribe((event) => seen.push(event));
    void session.prompt("hello");
    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "tasks" });
    ticks(20);
    expect(piMocks.agentSession.abort).toHaveBeenCalledTimes(1);
    emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "tasks", isError: false });
    seen.length = 0;
    // The tool's turn ends as it ran; the request after it never starts, and
    // Pi says so in its own words.
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "This operation was aborted",
      },
    });
    // Pi follows a failed turn_end with agent_end before the prompt settles.
    // willRetry false: the cut is the turn, not an attempt Pi will retry.
    emit({ type: "agent_end", willRetry: false, messages: [] });
    expect(seen).toEqual([
      {
        type: "turn_failed",
        taskId: "firstmate",
        error: turnTimeoutErrorMessage(20 * TICK_PERIOD_MS),
      },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed" },
    ]);
    session.dispose();
  });

  function toolTurn(n: number): unknown {
    return {
      type: "turn_end",
      message: { role: "assistant", stopReason: "toolUse", content: [] },
      toolResults: [{ role: "toolResult", toolCallId: `c${n}`, content: [] }],
    };
  }

  it("stops a prompt at the model-turn cap once the last turn's tools ran, and fails the turn in its words", async () => {
    const session = await openSeat(spec);
    const seen: unknown[] = [];
    session.subscribe((event) => seen.push(event));
    void session.prompt("hello");
    for (let n = 1; n < FIRSTMATE_MAX_MODEL_TURNS; n += 1) emit(toolTurn(n));
    // A failed attempt Pi retries is not a turn that answered.
    emit({ type: "turn_end", message: { role: "assistant", stopReason: "error", content: [] } });
    expect(piMocks.agentSession.abort).not.toHaveBeenCalled();
    emit(toolTurn(FIRSTMATE_MAX_MODEL_TURNS));
    expect(piMocks.agentSession.abort).toHaveBeenCalledTimes(1);
    seen.length = 0;
    // The request Pi was about to make ends aborted: the cap's failure.
    emit({ type: "turn_end", message: { stopReason: "aborted" } });
    expect(seen).toEqual([
      {
        type: "turn_failed",
        taskId: "firstmate",
        error: modelTurnsErrorMessage(FIRSTMATE_MAX_MODEL_TURNS),
      },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed" },
    ]);
    session.dispose();
  });

  it("lets a prompt whose last turn answers at the cap finish", async () => {
    const session = await openSeat(spec);
    void session.prompt("hello");
    for (let n = 1; n < FIRSTMATE_MAX_MODEL_TURNS; n += 1) emit(toolTurn(n));
    emit({
      type: "turn_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Aye." }] },
      toolResults: [],
    });
    expect(piMocks.agentSession.abort).not.toHaveBeenCalled();
    session.dispose();
  });
});

describe("stripFailedThinking", () => {
  it("removes thinking blocks from error and aborted assistant messages only", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "keep me" },
          { type: "text", text: "done" },
        ],
      },
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Response incomplete: max_time_limit",
        content: [
          { type: "thinking", thinking: "done. End. ".repeat(50), thinkingSignature: "blob" },
          { type: "text", text: "" },
        ],
      },
    ];
    stripFailedThinking(messages);
    expect(messages[1]).toEqual({
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "keep me" },
        { type: "text", text: "done" },
      ],
    });
    expect(messages[2]).toEqual({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Response incomplete: max_time_limit",
      content: [{ type: "text", text: "" }],
    });
  });
});
