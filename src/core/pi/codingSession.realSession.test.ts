import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { codingSpec } from "../../../tests/helpers/codingSession";
import type { BashOutcome } from "../jobs/jobManager";
import { boundTool } from "../session/tools";
import type { ModelRuntime } from "./types";

/**
 * The realSession contract test (hi-bit's technique): pins the exact
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
    sessionManagerOpen: vi.fn(() => ({ kind: "opened" })),
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
  },
) {
  return createPiSessionFactory({
    agentDir: input.agentDir,
    ...(input.runBash ? { runBash: input.runBash } : {}),
  }).open(
    codingSpec({
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
  );
}

/** The tools createAgentSession was handed, by name. */
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
