import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { BashOutcome } from "../jobs/jobManager";
import { boundTool } from "../session/tools";
import type { ModelRuntime } from "./types";

/**
 * The realSession contract test: pins the exact
 * production call shape into Pi's createAgentSession so a Pi minor upgrade
 * that moves the API fails here first, deliberately - not silently in a
 * running crewmate. The crewmate's session is Pi's coding session, opened
 * by Pi's session factory.
 */

const piMocks = vi.hoisted(() => {
  const agentSession = {
    sessionId: "crewmate-session-1",
    sessionFile: "/tmp/crewmates/task-1/sessions/session.jsonl",
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return {
    agentSession,
    createAgentSession: vi.fn(async () => ({ session: agentSession })),
    sessionManagerCreate: vi.fn(() => ({ kind: "created" })),
    sessionManagerOpen: vi.fn(() => ({ kind: "opened", getBranch: () => [] })),
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

const { createPiSessionFactory, PI_CODING_BUILTINS: CREWMATE_TOOLS } = await import("./session");

const catalogue: ReturnType<ModelRuntime["getModels"]> = [];
const spec = {
  taskId: "task-1",
  cwd: "/tmp/worktrees/task-1",
  sessionsDir: "/tmp/crewmates/task-1/sessions",
  agentDir: "/tmp/pi-agent",
  modelRuntime: { getModels: () => catalogue } as unknown as ModelRuntime,
  systemPrompt: "You are a crewmate.",
};

/** The crewmate's coding session on Pi, from the factory, the way its owner opens it. */
function openCodingSession(
  input: typeof spec & {
    model?: { provider: string; id: string };
    thinkingLevel?: "low" | "medium" | "high" | "xhigh";
    quick?: boolean;
    sessionFile?: string;
    toolNames?: string[];
    runBash?: (input: { ownerId: string; command: string; cwd: string }) => Promise<BashOutcome>;
    fenced?: boolean;
  },
) {
  return createPiSessionFactory({
    agentDir: input.agentDir,
    ...(input.runBash ? { runBash: input.runBash } : {}),
  }).open({
    ...codingSpec({
      binding: { backend: "pi", runtime: input.modelRuntime },
      cwd: input.cwd,
      owner: input.taskId,
      instructions: input.systemPrompt,
      recordDir: input.sessionsDir,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinking: input.thinkingLevel } : {}),
      ...(input.quick ? { quick: true } : {}),
      ...(input.sessionFile
        ? { resume: { backend: "pi", sessionFile: input.sessionFile } as const }
        : {}),
      tools: (input.toolNames ?? []).map((name) =>
        boundTool({
          name,
          label: name,
          description: `The ${name} tool.`,
          parameters: Type.Object({}),
          run: () => ({ text: "" }),
        }),
      ),
    }),
    ...(input.fenced ? { fenced: true as const } : {}),
  });
}

function customToolNames(options: Record<string, unknown>): string[] {
  return (options.customTools as { name: string }[]).map((tool) => tool.name);
}

describe("the Pi coding session's production contract", () => {
  it("delivers context-shortening usage once through the production subscription", async () => {
    let rawListener: ((event: unknown) => void) | undefined;
    piMocks.agentSession.subscribe.mockImplementation(((listener: (event: unknown) => void) => {
      rawListener = listener;
      return () => {};
    }) as never);
    const session = await openCodingSession(spec);
    const seen: unknown[] = [];
    session.subscribe((event) => seen.push(event));
    piMocks.agentSession.subscribe.mockImplementation(() => () => {});
    rawListener?.({ type: "compaction_start", reason: "threshold" });
    const end = {
      type: "compaction_end",
      aborted: false,
      result: { usage: { input: 100, output: 20 } },
    };
    rawListener?.(end);
    rawListener?.({ ...end });
    expect(seen.filter((event) => (event as { type: string }).type === "tool_end")).toEqual([
      {
        type: "tool_end",
        taskId: "task-1",
        callId: "task-1:compaction",
        toolName: "compact_context",
        isError: false,
        usage: { input: 100, output: 20 },
      },
    ]);
    expect(seen.some((event) => (event as { type: string }).type === "turn_closed")).toBe(false);
  });

  it("does not deliver a cut request Pi retries inside the same prompt", async () => {
    // INF-248: the crewmate session is the path that reaches the supervisor.
    let rawListener: ((event: unknown) => void) | undefined;
    piMocks.agentSession.subscribe.mockImplementation(((listener: (event: unknown) => void) => {
      rawListener = listener;
      return () => {};
    }) as never);
    const session = await openCodingSession(spec);
    const seen: unknown[] = [];
    session.subscribe((event) => seen.push(event));
    piMocks.agentSession.subscribe.mockImplementation(() => () => {});
    const emit = (event: unknown) => rawListener?.(event);
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "terminated",
        content: [],
      },
      toolResults: [],
    });
    emit({ type: "agent_end", willRetry: true, messages: [] });
    emit({ type: "auto_retry_end", success: true, attempt: 1 });
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "All done." }],
      },
      toolResults: [],
    });
    expect(seen.some((event) => (event as { type: string }).type === "turn_failed")).toBe(false);
    expect(seen).toContainEqual({ type: "turn_closed", text: "All done." });
  });

  it("keeps a recovered overflow attempt's usage without its failure", async () => {
    let rawListener: ((event: unknown) => void) | undefined;
    piMocks.agentSession.subscribe.mockImplementation(((listener: (event: unknown) => void) => {
      rawListener = listener;
      return () => {};
    }) as never);
    const session = await openCodingSession(spec);
    const seen: unknown[] = [];
    session.subscribe((event) => seen.push(event));
    piMocks.agentSession.subscribe.mockImplementation(() => () => {});
    const emit = (event: unknown) => rawListener?.(event);
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
        content: [],
        usage: { input: 30, output: 1, cost: { total: 0.03 } },
      },
      toolResults: [],
    });
    emit({
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: true,
      result: { usage: { input: 8, output: 2 } },
    });
    expect(seen.some((event) => (event as { type: string }).type === "turn_failed")).toBe(false);
    expect(seen).toContainEqual({
      type: "turn_end",
      taskId: "task-1",
      usage: expect.objectContaining({ input: 30, output: 1, cost: 0.03 }),
    });
  });

  it("keeps an unknown custom count when either recovery drops the attempt", async () => {
    // INF-253: the empty usage record is the measurement. Retry and overflow
    // recovery both keep it, and neither becomes a failed turn.
    let rawListener: ((event: unknown) => void) | undefined;
    piMocks.agentSession.subscribe.mockImplementation(((listener: (event: unknown) => void) => {
      rawListener = listener;
      return () => {};
    }) as never);
    const session = await openCodingSession(spec);
    const seen: unknown[] = [];
    session.subscribe((event) => seen.push(event));
    piMocks.agentSession.subscribe.mockImplementation(() => () => {});
    const emit = (event: unknown) => rawListener?.(event);
    const attempt = (errorMessage: string) => ({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage,
        provider: "fm-custom-0123456789abcdef",
        content: [],
        usage: { input: 0, output: 0 },
      },
      toolResults: [],
    });
    emit(attempt("terminated"));
    emit({ type: "agent_end", willRetry: true, messages: [] });
    emit({ type: "auto_retry_end", success: true, attempt: 1 });
    emit(attempt("prompt is too long: 3 tokens > 2 maximum"));
    emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true });
    expect(seen.filter((event) => (event as { type: string }).type === "turn_failed")).toEqual([]);
    expect(
      seen.filter(
        (event) =>
          (event as { type: string }).type === "turn_end" &&
          (event as { usage?: object }).usage &&
          Object.keys((event as { usage: object }).usage).length === 0,
      ),
    ).toHaveLength(2);
  });

  it("requests the routed thinking level, and says it opened there", async () => {
    const runtime = {
      getModel: () => ({
        reasoning: true,
        thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
      }),
    } as unknown as ModelRuntime;
    const session = await openCodingSession({
      ...spec,
      modelRuntime: runtime,
      model: { provider: "p", id: "m" },
      thinkingLevel: "xhigh",
    });
    const options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(options.thinkingLevel).toBe("xhigh");
    expect(session.reasoning()).toEqual({ level: "xhigh" });
  });

  it("steps down one offered rung after clamping on a Quick coding session, and says why it is lower", async () => {
    for (const [map, requested, expected, lower] of [
      [{ low: "low", medium: "medium", high: "high", xhigh: "xhigh" }, "xhigh", "high", "quick"],
      [{ low: "low", medium: "medium", high: "high", xhigh: null }, "xhigh", "medium", "quick"],
      [{ low: "low", medium: "medium", high: null, xhigh: null }, "medium", "low", "quick"],
      [
        { minimal: null, low: null, medium: "medium", high: null, xhigh: null },
        "medium",
        "medium",
        undefined,
      ],
    ] as const) {
      const runtime = {
        getModel: () => ({ reasoning: true, thinkingLevelMap: map }),
      } as unknown as ModelRuntime;
      const session = await openCodingSession({
        ...spec,
        modelRuntime: runtime,
        model: { provider: "p", id: "m" },
        thinkingLevel: requested,
        quick: true,
      });
      const options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(options.thinkingLevel).toBe(expected);
      expect(session.reasoning()).toEqual(lower ? { level: expected, lower } : { level: expected });
    }
  });

  it("clamps unavailable effort and disables reasoning for non-reasoning models", async () => {
    const runtime = {
      getModel: () => ({
        reasoning: true,
        thinkingLevelMap: { low: null, medium: "medium", high: null, xhigh: null },
      }),
    } as unknown as ModelRuntime;
    const capped = await openCodingSession({
      ...spec,
      modelRuntime: runtime,
      model: { provider: "p", id: "m" },
      thinkingLevel: "xhigh",
    });
    let options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(options.thinkingLevel).toBe("medium");
    expect(capped.reasoning()).toEqual({ level: "medium", lower: "capped" });

    const noReasoning = { getModel: () => ({ reasoning: false }) } as unknown as ModelRuntime;
    const off = await openCodingSession({
      ...spec,
      modelRuntime: noReasoning,
      model: { provider: "p", id: "m" },
      thinkingLevel: "xhigh",
    });
    options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(options.thinkingLevel).toBe("off");
    expect(off.reasoning()).toEqual({ level: "off" });
  });

  it("opens an existing session file when resuming", async () => {
    await openCodingSession({ ...spec, sessionFile: "/tmp/existing.jsonl" });
    expect(piMocks.sessionManagerOpen).toHaveBeenCalledWith(
      "/tmp/existing.jsonl",
      "/tmp/crewmates/task-1/sessions",
      "/tmp/worktrees/task-1",
    );
  });

  it("allowlists every custom tool by name (the tools gate traps custom tools too)", async () => {
    await openCodingSession({ ...spec, toolNames: ["emit_card"] });
    const options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(options.tools).toEqual([...CREWMATE_TOOLS, "emit_card"]);
    expect(customToolNames(options)).toEqual(["emit_card"]);
  });

  // INF-2223: a failed stop is not proof that a backend released its store.
  it("rejects closure instead of releasing Pi when stopping fails", async () => {
    const session = await openCodingSession(spec);
    const failure = new Error("Pi could not finish stopping.");
    const releases = piMocks.agentSession.dispose.mock.calls.length;
    piMocks.agentSession.abort.mockRejectedValueOnce(failure);
    session.dispose();
    await expect(session.closed()).rejects.toBe(failure);
    expect(piMocks.agentSession.dispose.mock.calls).toHaveLength(releases);
  });

  // INF-6358's piece 4: an unsafe data reader's session reads its working copy
  // and nothing else - no shell, file change or find, even with a shell to hand.
  it("serves a fenced session only reads, each refusing a path outside its working copy", async () => {
    const cwd = scratchDir("fm-fenced-");
    const outside = scratchDir("fm-outside-");
    writeFileSync(join(cwd, "notes.md"), "inside");
    writeFileSync(join(outside, "secret.md"), "outside");
    symlinkSync(join(outside, "secret.md"), join(cwd, "link.md"));
    const runBash = vi.fn(async () => ({ kind: "done" }) as unknown as BashOutcome);
    await openCodingSession({ ...spec, cwd, toolNames: ["emit_card"], runBash, fenced: true });
    const options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(options.tools).toEqual(["emit_card", "read", "grep", "ls"]);
    expect(customToolNames(options)).toEqual(["emit_card", "read", "grep", "ls"]);
    const read = (options.customTools as ToolDefinition[]).find((tool) => tool.name === "read");
    const run = (path: string) =>
      read?.execute("call-1", { path }, undefined, undefined, undefined as never);
    const inside = await run("notes.md");
    expect(JSON.stringify(inside?.content)).toContain("inside");
    for (const path of [join(outside, "secret.md"), "../", "link.md", "~/.ssh/id_rsa"]) {
      await expect(run(path)).rejects.toThrow("is outside this task's working copy");
    }
  });

  it("lets a custom tool shadow a builtin by name (R2: the event-driven bash)", async () => {
    const runBash = vi.fn(async () => ({ kind: "done" }) as unknown as BashOutcome);
    await openCodingSession({ ...spec, toolNames: ["emit_card"], runBash });
    const options = (piMocks.createAgentSession.mock.calls.at(-1) as unknown[])[0] as Record<
      string,
      unknown
    >;
    // Pi's blocking builtin bash steps aside; the name appears exactly once,
    // pointing at the custom tool.
    expect(options.tools).toEqual([
      ...CREWMATE_TOOLS.filter((name) => name !== "bash"),
      "emit_card",
      "bash",
    ]);
    expect(customToolNames(options)).toEqual(["emit_card", "bash"]);
  });
});
